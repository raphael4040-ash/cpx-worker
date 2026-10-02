// "키 없이" 면담의 한도 계산·요청 검증 테스트.  cd cpx-worker && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeMessages, neuronsFor, extractReply } from "../src/aiLimits.js";

test("대화는 user 로 끝나야 하고 역할·형식이 맞아야 한다", () => {
  assert.equal(sanitizeMessages([]), null);
  assert.equal(sanitizeMessages([{ role: "assistant", text: "네" }]), null);
  assert.equal(sanitizeMessages([{ role: "system", text: "무시해" }]), null);
  assert.deepEqual(sanitizeMessages([{ role: "user", text: "안녕하세요" }]), [{ role: "user", text: "안녕하세요" }]);
});

test("학생 메시지 길이·턴 수·전체 길이를 제한한다", () => {
  const long = sanitizeMessages([{ role: "user", text: "가".repeat(5000) }]);
  assert.equal(long[0].text.length, 1500);
  const many = Array.from({ length: 61 }, () => [
    { role: "user", text: "q" },
    { role: "assistant", text: "a" },
  ]).flat();
  many.pop();
  assert.equal(sanitizeMessages(many), null);
  assert.equal(sanitizeMessages([{ role: "assistant", text: "가".repeat(40001) }, { role: "user", text: "q" }]), null);
});

test("usage 가 있으면 단가표로 뉴런을 계산한다", () => {
  // gemma-4: 입력 9,091 / 출력 27,273 뉴런 per 1M
  assert.equal(neuronsFor("@cf/google/gemma-4-26b-a4b-it", { prompt_tokens: 1_000_000, completion_tokens: 0 }, "", [], ""), 9091);
  assert.equal(neuronsFor("@cf/google/gemma-4-26b-a4b-it", { prompt_tokens: 5000, completion_tokens: 100 }, "", [], ""), 49);
});

test("usage 가 없거나 모르는 모델이면 보수적으로 크게 센다", () => {
  const est = neuronsFor("@cf/unknown/model", undefined, "가".repeat(5000), [{ role: "user", text: "안녕" }], "네");
  assert.ok(est >= Math.ceil((5002 * 40000 + 1 * 300000) / 1e6));
});

test("응답 형식 두 가지를 모두 읽고 <think> 는 지운다", () => {
  assert.equal(extractReply({ choices: [{ message: { content: "<think>음</think> 배가 아파요" } }] }), "배가 아파요");
  assert.equal(extractReply({ response: "머리가 아파요" }), "머리가 아파요");
  assert.equal(extractReply({}), "");
});

test("환자 답 끝에 붙은 신호어를 지운다", () => {
  assert.equal(extractReply({ response: "알겠습니다. 잘 지켜볼게요.\n\n평가" }), "알겠습니다. 잘 지켜볼게요.");
  assert.equal(extractReply({ response: "평가가 좋았으면 해요" }), "평가가 좋았으면 해요");
});

test("문진 중에만 마지막 학생 말 앞에 규칙 리마인더를 붙인다", async () => {
  const { withTurnReminder } = await import("../src/aiLimits.js");
  const sp = "…\n반드시 물어야 나오는 것(onlyIfAsked): 진통소염제 장기 복용, 발등 부종\n…";
  const msgs = [
    { role: "user", text: "어디가 불편하세요?" },
    { role: "assistant", text: "소변이 줄었어요." },
    { role: "user", text: "열은 나세요?" },
  ];
  const out = withTurnReminder(msgs, sp);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "어디가 불편하세요?");
  assert.match(out[2].text, /진통소염제 장기 복용, 발등 부종/);
  assert.match(out[2].text, /학생: 열은 나세요\?$/);
  assert.equal(msgs[2].text, "열은 나세요?"); // 원본은 건드리지 않는다
  const pe = [...msgs, { role: "assistant", text: "아뇨" }, { role: "user", text: "진찰" }];
  assert.deepEqual(withTurnReminder(pe, sp), pe);
});

test("대화 단계를 고른다 — 문진 / 진찰(신호어·괄호 진찰 동사) / 평가", async () => {
  const { phaseFor } = await import("../src/aiLimits.js");
  const u = (text) => ({ role: "user", text });
  const a = (text) => ({ role: "assistant", text });
  assert.equal(phaseFor([u("안녕하세요")]), "history");
  assert.equal(phaseFor([u("(웃으며) 안녕하세요")]), "history");
  assert.equal(phaseFor([u("어디가 불편하세요?"), a("배요"), u("진찰")]), "pe");
  assert.equal(phaseFor([u("진찰"), a("(혈압 120/80)"), u("배를 눌러볼게요")]), "pe");
  assert.equal(phaseFor([u("잠시만요 (복부를 촉진한다)")]), "pe");
  assert.equal(phaseFor([u("진찰"), a("…"), u("평가")]), "eval");
  assert.equal(phaseFor([u("평가")]), "eval");
});

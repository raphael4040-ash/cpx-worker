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

test("평가처럼 생긴 답을 가려낸다 — 환자 대사는 걸리지 않는다", async () => {
  const { looksLikeEvaluation, withNotYetEvalNote } = await import("../src/aiLimits.js");
  assert.equal(looksLikeEvaluation("평가를 시작하겠습니다.\n\n[CPX 채점표 기반 평가]\n2. 병력 청취"), true);
  assert.equal(looksLikeEvaluation("잘한 점\n- …\n개선점\n- …"), true);
  assert.equal(looksLikeEvaluation("```cpx-record\n{}\n```"), true);
  assert.equal(looksLikeEvaluation("네, 알겠습니다. 검사 결과 나오면 꼭 알려주세요."), false);
  assert.equal(looksLikeEvaluation("채점이요? 무슨 말씀이세요?"), false);
  const out = withNotYetEvalNote([{ role: "user", text: "정리하면 …" }]);
  assert.match(out[0].text, /^정리하면 …\n\n\(아직 "평가" 신호가 아닙니다/);
});

import { feedbackOnlyMessages, insertFeedback, isOpeningTurn } from "../src/aiLimits.js";

test("개선점 재요청은 대화와 채점표만 보내고 평가 신호는 뺀다", () => {
  const msgs = [
    { role: "user", text: "어디가 불편하세요?" },
    { role: "assistant", text: "배가 아파요." },
    { role: "user", text: "평가" },
  ];
  const [m] = feedbackOnlyMessages(msgs, "채점표 내용\n```cpx-record\n{}\n```");
  assert.match(m.text, /학생: 어디가 불편하세요\?/);
  assert.doesNotMatch(m.text, /학생: 평가/);
  assert.doesNotMatch(m.text, /cpx-record/);
});

test("개선점은 기록 블록 앞에 끼운다", () => {
  const out = insertFeedback("채점표\n```cpx-record\n{}\n```", "개선점\n1. \"언제부터요?\"");
  assert.ok(out.indexOf("개선점") < out.indexOf("```cpx-record"));
  assert.match(insertFeedback("채점표", "1. 질문"), /개선점\n1\. 질문$/);
});

test("첫 대사는 내원 이유만 처음 물었을 때 모델 없이 낸다", () => {
  const op = ["배가 아파서 왔어요."];
  assert.equal(isOpeningTurn([{ role: "user", text: "어디가 불편해서 오셨어요?" }], op), true);
  assert.equal(isOpeningTurn([{ role: "user", text: "성함이랑 어디가 불편하신지 말씀해 주세요" }], op), false);
  assert.equal(isOpeningTurn([{ role: "user", text: "안녕하세요" }], op), false);
  assert.equal(
    isOpeningTurn(
      [
        { role: "user", text: "어떻게 오셨어요?" },
        { role: "assistant", text: "배가 아파서 왔어요." },
        { role: "user", text: "어디가 아프세요?" },
      ],
      op
    ),
    false
  );
  assert.equal(isOpeningTurn([{ role: "user", text: "어떻게 오셨어요?" }], []), false);
});

import { withTimeout } from "../src/aiLimits.js";

test("withTimeout: 응답이 영영 안 오면 ai_timeout 으로 거절하고, 제때 오면 그대로 돌려준다", async () => {
  const never = new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(withTimeout(never, 50), { message: "ai_timeout" });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000), "ok");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), { message: "boom" });
});

import { tokenCounts } from "../src/aiLimits.js";

test("tokenCounts: usage 가 오면 그대로, 안 오면 글자 수로 추정한다", () => {
  assert.deepEqual(tokenCounts({ prompt_tokens: 1200, completion_tokens: 80 }, "시스템", [{ text: "안녕" }], "답"), { tin: 1200, tout: 80 });
  assert.deepEqual(tokenCounts(undefined, "시스템", [{ text: "안녕" }, { text: "하세요" }], "답변"), { tin: 3 + 2 + 3, tout: 2 });
});

test("neuronsFor 는 tokenCounts 와 같은 토큰 수로 계산한다 (리팩터링 전과 값이 같다)", () => {
  const model = "@cf/google/gemma-4-26b-a4b-it"; // 입력 9091 · 출력 27273 뉴런/100만 토큰
  assert.equal(neuronsFor(model, { prompt_tokens: 1000000, completion_tokens: 0 }, "", [], ""), 9091);
  assert.equal(neuronsFor(model, { prompt_tokens: 0, completion_tokens: 1000000 }, "", [], ""), 27273);
});

import { parseUserLimit, validUid, MAX_USER_LIMIT } from "../src/aiLimits.js";

test("계정별 면담 횟수: 1~상한의 정수만 받는다", () => {
  assert.equal(parseUserLimit(5), 5);
  assert.equal(parseUserLimit("5"), 5);
  assert.equal(parseUserLimit(MAX_USER_LIMIT), MAX_USER_LIMIT);
  for (const bad of [0, -1, MAX_USER_LIMIT + 1, 2.5, "", "abc", null, undefined, NaN, {}, [5]]) assert.equal(parseUserLimit(bad), null, String(bad));
});

test("uid 검증: KV 키에 안전한 모양만", () => {
  assert.equal(validUid("S4b2Zqzff2XHNznL1Wcq6RiZVGv1"), true);
  for (const bad of ["", "ab", "a b c d e f", "../x", "uid:evil", "x".repeat(200), 5, null]) assert.equal(validUid(bad), false, String(bad));
});

test("Workers AI 용량 초과(3040)만 재시도 대상으로 본다", async () => {
  const { isCapacityError } = await import("../src/aiLimits.js");
  assert.equal(isCapacityError("3040: Capacity temporarily exceeded, please try again."), true);
  assert.equal(isCapacityError("AiError: 3040: capacity temporarily exceeded"), true);
  for (const m of ["ai_timeout", "4006: daily free allocation of 10,000 neurons exceeded", "InferenceUpstreamError: bad request", "", null, undefined])
    assert.equal(isCapacityError(m), false, String(m));
});

test("턴 리마인더: 묶음 질문·'다른 증상' 질문일 때만 해당 한 줄이 붙는다", async () => {
  const { turnHints, withTurnReminder } = await import("../src/aiLimits.js");
  assert.equal(turnHints("열은 나세요?"), "");
  assert.equal(turnHints("마지막 생리는 언제였나요?"), "");
  assert.match(turnHints("두통이나 시야 이상, 젖이 나오는 증상은 없으세요?"), /하나도 빼지 않고/);
  assert.match(turnHints("체중 변화나 다른 증상은요?"), /하나도 빼지 않고/);
  assert.match(turnHints("체중 변화나 다른 증상은요?"), /다른 증상/);
  assert.match(turnHints("그 외에 다른 증상은 없으세요?"), /그런 건 없어요/);
  assert.doesNotMatch(turnHints("그 외에 다른 증상은 없으세요?"), /하나도 빼지 않고/);
  const sp = "…\n반드시 물어야 나오는 것(onlyIfAsked): 가족력\n…";
  const out = withTurnReminder([{ role: "user", text: "그 외에 다른 증상은 없으세요?" }], sp);
  assert.match(out[0].text, /아까도 말했지만/);
  assert.match(out[0].text, /학생: 그 외에 다른 증상은 없으세요\?$/);
});

test("턴 리마인더: 약을 물으면 약국 약까지 빠짐없이 말하라는 줄이 붙는다", async () => {
  const { turnHints } = await import("../src/aiLimits.js");
  for (const q of ["복용 중인 약이 있으세요?", "평소 드시는 약은요?", "복용 중인 약이나 과거 병력, 술은 어떠세요?", "진통제나 영양제 드세요?"]) {
    assert.match(turnHints(q), /약국에서 사 먹는 약/, q);
  }
  for (const q of ["열은 나세요?", "언제부터 그러셨나요?", "약간 어지러우세요?", "약속이 있으신가요?"]) {
    assert.doesNotMatch(turnHints(q), /약국에서 사 먹는 약/, q);
  }
});

test("턴 리마인더: 과거 병력을 물으면 카드의 과거력까지 말하라는 줄이 붙는다", async () => {
  const { turnHints } = await import("../src/aiLimits.js");
  for (const q of ["과거 병력은 있으세요?", "복용 중인 약이나 과거 병력, 담배와 술은 어떠세요?", "예전에 앓았던 병이 있나요?", "수술이나 입원하신 적은요?", "진단받은 병이 있으세요?"]) {
    assert.match(turnHints(q), /카드의 과거력/, q);
  }
  for (const q of ["열은 나세요?", "언제부터 그러셨나요?", "가래 색은 어떤가요?"]) {
    assert.doesNotMatch(turnHints(q), /카드의 과거력/, q);
  }
  assert.match(turnHints("평소 쓰시는 약 있으세요?"), /흡입기/);
});

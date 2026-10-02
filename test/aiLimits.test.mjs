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

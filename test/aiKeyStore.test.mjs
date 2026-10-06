// 계정별 AI 키 보관(검증·암호화) 테스트.  cd cpx-worker && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_PROVIDERS, MAX_VALUE_CHARS, pickKnown, normalizePut, seal, open } from "../src/aiKeyStore.js";

test("허용된 제공자의 알맞은 문자열만 남긴다", () => {
  assert.deepEqual(pickKnown({ gemini: " abc ", openai: "", anthropic: 5, evil: "x", openrouter: "k".repeat(MAX_VALUE_CHARS + 1) }), { gemini: "abc" });
  assert.deepEqual(pickKnown(null), {});
  assert.deepEqual(KEY_PROVIDERS, ["gemini", "openai", "anthropic", "openrouter"]);
});

test("put 바디를 정리한다 — 제공자가 이상하면 free, 키가 없어도 저장은 허용(제공자만 바꾸는 경우)", () => {
  assert.deepEqual(normalizePut({ aiKeys: { openai: "sk", junk: "x" }, aiModels: { openai: "m" }, aiProvider: "openai" }), {
    aiKeys: { openai: "sk" },
    aiModels: { openai: "m" },
    aiProvider: "openai",
  });
  assert.equal(normalizePut({ aiKeys: {}, aiProvider: "weird" }).aiProvider, "free");
  assert.deepEqual(normalizePut({ aiProvider: "free" }), { aiKeys: {}, aiModels: {}, aiProvider: "free" });
});

test("올바른 모양이 아니거나 너무 크면 거절한다", () => {
  assert.equal(normalizePut(null), null);
  assert.equal(normalizePut("x"), null);
  assert.equal(normalizePut({ aiKeys: { openai: "k" }, padding: "x".repeat(5000) }), null);
});

test("secret 이 있으면 암호화해 저장하고 같은 계정에서만 풀린다", async () => {
  const data = { aiKeys: { openai: "sk-secret-123" }, aiModels: {}, aiProvider: "openai" };
  const stored = await seal(data, "server-secret", "uidA");
  assert.match(stored, /^e1:/);
  assert.ok(!stored.includes("sk-secret-123"), "저장값에 키가 그대로 보이면 안 된다");
  assert.deepEqual(await open(stored, "server-secret", "uidA"), data);
  await assert.rejects(open(stored, "server-secret", "uidB")); // 다른 계정의 암호문은 풀리지 않는다
  await assert.rejects(open(stored, "other-secret", "uidA")); // 다른 비밀값으로도 풀리지 않는다
  await assert.rejects(open(stored, "", "uidA"), /secret_missing/);
});

test("같은 내용도 저장할 때마다 암호문이 다르다 (IV 가 매번 새로 만들어진다)", async () => {
  const data = { aiKeys: { openai: "k" } };
  assert.notEqual(await seal(data, "s", "u"), await seal(data, "s", "u"));
});

test("secret 이 없으면 평문으로 저장하고, 나중에 secret 을 추가해도 예전 데이터는 읽힌다", async () => {
  const data = { aiKeys: { gemini: "g" }, aiModels: {}, aiProvider: "gemini" };
  const plain = await seal(data, "", "u");
  assert.match(plain, /^p1:/);
  assert.deepEqual(await open(plain, "", "u"), data);
  assert.deepEqual(await open(plain, "now-set", "u"), data); // 비밀값이 생긴 뒤에도 평문 기록은 그대로 읽힌다
});

test("저장된 값이 없거나 알 수 없는 형식이면 null", async () => {
  assert.equal(await open(null, "s", "u"), null);
  assert.equal(await open("", "s", "u"), null);
  assert.equal(await open("zz:whatever", "s", "u"), null);
});

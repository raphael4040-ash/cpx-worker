import test from "node:test";
import assert from "node:assert/strict";
import { toGeminiBody, fromGeminiResponse, callGemini, probeGemini, geminiConfigured, isGeminiQuotaError } from "../src/geminiBackend.js";

test("toGeminiBody: 역할 변환·연속 역할 병합·첫 user 보장", () => {
  const b = toGeminiBody("SYS", [{ role: "assistant", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }], { maxTokens: 10, temperature: 0.5 });
  assert.equal(b.systemInstruction.parts[0].text, "SYS");
  assert.deepEqual(b.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(b.contents[2].parts[0].text, "b\nc");
  assert.equal(b.generationConfig.maxOutputTokens, 10);
});

test("fromGeminiResponse: 텍스트·토큰(사고 토큰 포함)", () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ text: "안녕" }, { text: "하세요" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } });
  assert.equal(r.response, "안녕하세요");
  assert.deepEqual(r.usage, { prompt_tokens: 7, completion_tokens: 5 });
  assert.equal(fromGeminiResponse({}).response, "");
});

test("callGemini: 키는 헤더로, 오류 메시지의 키는 가려진다", async () => {
  let seen;
  const ok = await callGemini({ GEMINI_API_KEY: "k".repeat(20) }, { system: "s", msgs: [{ role: "user", text: "x" }], maxTokens: 5, temperature: 0 }, async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
  });
  assert.equal(ok.response, "ok");
  assert.equal(seen.init.headers["x-goog-api-key"], "k".repeat(20));
  assert.ok(!seen.url.includes("k".repeat(20)));
  await assert.rejects(
    callGemini({ GEMINI_API_KEY: "k".repeat(20) }, { system: "s", msgs: [], maxTokens: 5, temperature: 0 }, async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "quota key=SECRET123 exceeded" } }) })),
    (e) => isGeminiQuotaError(e.message) && !e.message.includes("SECRET123")
  );
});

test("probeGemini: 미설정·차단·네트워크 오류", async () => {
  assert.deepEqual(await probeGemini({}), { configured: false });
  assert.equal(geminiConfigured({ GEMINI_API_KEY: "short" }), false);
  const blocked = await probeGemini({ GEMINI_API_KEY: "k".repeat(20) }, async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "User location is not supported for the API use." } }) }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /location/);
  const net = await probeGemini({ GEMINI_API_KEY: "k".repeat(20) }, async () => { throw new Error("boom"); });
  assert.equal(net.status, 0);
});

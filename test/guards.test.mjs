// CORS 허용 목록과 IP 레이트리밋 테스트.  cd cpx-worker && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOrigins, corsFor, checkRateLimit } from "../src/guards.js";

const req = (origin) => new Request("https://w.test/x", { headers: origin ? { Origin: origin } : {} });

test("CORS: 허용 목록에 있는 Origin 만 그대로 되돌려 준다", () => {
  for (const o of ["https://cpx-practice.github.io", "https://raphael4040-ash.github.io", "http://localhost:8123"]) {
    assert.equal(corsFor(req(o), {})["Access-Control-Allow-Origin"], o);
  }
  assert.equal(corsFor(req("https://evil.example"), {})["Access-Control-Allow-Origin"], undefined);
  // 접두사만 같은 도메인은 통과하면 안 된다
  assert.equal(corsFor(req("https://cpx-practice.github.io.evil.example"), {})["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsFor(req("http://cpx-practice.github.io"), {})["Access-Control-Allow-Origin"], undefined);
});

test("CORS: Origin 이 없는 호출(훅의 curl)은 헤더 없이도 통하고, Vary 는 항상 붙는다", () => {
  const h = corsFor(req(null), {});
  assert.equal(h["Access-Control-Allow-Origin"], undefined);
  assert.equal(h.Vary, "Origin");
  assert.match(h["Access-Control-Allow-Headers"], /Authorization/);
});

test("CORS: ALLOWED_ORIGINS 환경변수로 바꿀 수 있고, 비어 있으면 기본값을 쓴다", () => {
  const env = { ALLOWED_ORIGINS: " https://a.example , https://b.example " };
  assert.deepEqual(allowedOrigins(env), ["https://a.example", "https://b.example"]);
  assert.equal(corsFor(req("https://a.example"), env)["Access-Control-Allow-Origin"], "https://a.example");
  assert.equal(corsFor(req("https://cpx-practice.github.io"), env)["Access-Control-Allow-Origin"], undefined);
  assert.ok(allowedOrigins({ ALLOWED_ORIGINS: " , " }).includes("https://cpx-practice.github.io"));
});

const fakeKv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), m };
};

test("레이트리밋: KV 나 IP 가 없으면 통과한다", async () => {
  assert.equal(await checkRateLimit(null, "1.2.3.4"), true);
  assert.equal(await checkRateLimit(fakeKv(), ""), true);
});

test("레이트리밋: 한도까지는 통과하고 넘으면 막으며, IP 와 prefix 별로 따로 센다", async () => {
  const kv = fakeKv();
  const opt = { prefix: "aiStart", max: 3, windowSec: 600 };
  for (let i = 0; i < 3; i++) assert.equal(await checkRateLimit(kv, "5.5.5.5", opt), true);
  assert.equal(await checkRateLimit(kv, "5.5.5.5", opt), false);
  assert.equal(await checkRateLimit(kv, "6.6.6.6", opt), true); // 다른 IP
  assert.equal(await checkRateLimit(kv, "5.5.5.5"), true); // 기본 prefix(iv) 는 따로 센다
  assert.ok(kv.m.has("aiStart:5.5.5.5") && kv.m.has("iv:5.5.5.5"));
});

test("레이트리밋: KV 가 실패해도 정상 사용자는 막지 않는다", async () => {
  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
  assert.equal(await checkRateLimit(broken, "1.1.1.1"), true);
  const putFails = { get: async () => null, put: async () => { throw new Error("kv down"); } };
  assert.equal(await checkRateLimit(putFails, "1.1.1.1"), true);
});

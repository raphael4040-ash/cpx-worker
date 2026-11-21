// KV 쓰기 묶기 — 카운터는 모았다가 쓰고, 면담별 사용량은 첫 턴·평가·몇 턴마다만 쓴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCounter, pendingFor, dropPending, shouldFlushUsage, _resetBatch, NEURON_FLUSH, USAGE_FLUSH_TURNS } from "../src/kvBatch.js";

const fakeKv = () => {
  const m = new Map();
  let puts = 0;
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { puts++; m.set(k, v); }, m, puts: () => puts };
};

test("addCounter: 한도 전에는 모으기만 하고, 차면 KV 값 + 모은 몫을 한 번에 쓴다", async () => {
  _resetBatch();
  const kv = fakeKv();
  await addCounter(kv, "n", 1000, 100, NEURON_FLUSH);
  await addCounter(kv, "n", 1000, 100, NEURON_FLUSH);
  assert.equal(kv.puts(), 0);
  assert.equal(pendingFor("n"), 200);
  await addCounter(kv, "n", 1000, 150, NEURON_FLUSH);
  assert.equal(kv.puts(), 1);
  assert.equal(kv.m.get("n"), "1350");
  assert.equal(pendingFor("n"), 0);
});

test("addCounter: force 면 바로 쓰고, 쓰기 실패하면 모은 몫을 남겨 둔다", async () => {
  _resetBatch();
  const kv = fakeKv();
  await addCounter(kv, "g", 3, 1, 5, { force: true });
  assert.equal(kv.m.get("g"), "4");
  const broken = { put: async () => { throw new Error("KV put() limit exceeded"); } };
  await addCounter(broken, "g", 4, 7, 5);
  assert.equal(pendingFor("g"), 7);
  dropPending("g");
  assert.equal(pendingFor("g"), 0);
});

test("shouldFlushUsage: 첫 턴·평가·몇 턴마다만", () => {
  assert.equal(shouldFlushUsage({ modelTurns: 1, localTurns: 0 }, "history"), true);
  assert.equal(shouldFlushUsage({ modelTurns: 1, localTurns: 1 }, "history"), false);
  assert.equal(shouldFlushUsage({ modelTurns: 3, localTurns: 0 }, "eval"), true);
  assert.equal(shouldFlushUsage({ modelTurns: USAGE_FLUSH_TURNS, localTurns: 0 }, "pe"), true);
  // 20턴 면담이면 사용량 쓰기는 5번 남짓 (예전에는 20번)
  let writes = 0;
  for (let t = 1; t <= 20; t++) if (shouldFlushUsage({ modelTurns: t, localTurns: 0 }, t === 20 ? "eval" : "history")) writes++;
  assert.ok(writes <= 5, String(writes));
});

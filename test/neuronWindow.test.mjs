import { test } from "node:test";
import assert from "node:assert/strict";
import { windowKeys, hourKey, corrected, freeAt, neuronsUsed, addNeurons, currentBase, HOLD_KEY, WINDOW_HOURS, _resetWindow } from "../src/neuronWindow.js";
import { _resetBatch } from "../src/kvBatch.js";

const fakeKv = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => void m.set(k, String(v)) };
};
const T = Date.parse("2026-11-24T00:18:38Z");

test("창은 지금 시간 칸과 앞 24칸", () => {
  const ks = windowKeys(T);
  assert.equal(ks.length, WINDOW_HOURS);
  assert.equal(ks.at(-1), "ai:neurons:h:2026-11-24T00");
  assert.equal(ks[0], "ai:neurons:h:2026-11-23T00");
});

test("어제 저녁 사용량이 오늘 아침까지 잡힌다 (2026-11-24 4006 상황)", async () => {
  _resetWindow(); _resetBatch();
  const kv = fakeKv({ [hourKey(Date.parse("2026-11-23T13:00Z"))]: "3464", [hourKey(Date.parse("2026-11-23T14:00Z"))]: "2581", [hourKey(Date.parse("2026-11-23T15:00Z"))]: "2129", [hourKey(Date.parse("2026-11-23T22:00Z"))]: "585", [hourKey(T)]: "1500", [hourKey(Date.parse("2026-11-22T23:00Z"))]: "999" });
  assert.equal(await neuronsUsed(kv, 9000, T), 3464 + 2581 + 2129 + 585 + 1500); // 25시간 전 칸은 빠진다
  // 다시 시작할 수 있는 때: 23T13 칸이 빠지는 24T14:00 (13시 + 25시간)
  const vals = await Promise.all(windowKeys(T).map((k) => kv.get(k).then((v) => +(v || 0))));
  assert.equal(freeAt(vals, 9000, 2000, T), "2026-11-24T14:00:00.000Z");
  assert.equal(freeAt(vals.map(() => 0), 9000, 2000, T), null);
});

test("4006 으로 멈춘 동안은 상한으로 본다", async () => {
  _resetWindow(); _resetBatch();
  assert.equal(await neuronsUsed(fakeKv({ [HOLD_KEY]: "1" }), 9000, T), 9000);
});

test("쌓을 때 보정 계수를 곱하고 지금 시간 칸에 쓴다", async () => {
  _resetWindow(); _resetBatch();
  const kv = fakeKv({ [hourKey(T)]: "100" });
  assert.equal(corrected(400), 500);
  await addNeurons(kv, await currentBase(kv, T), 400, { force: true, now: T });
  assert.equal(kv.m.get(hourKey(T)), "600");
  await addNeurons(kv, 600, 20, { now: T }); // 모아 두기 — KV 는 그대로, 판단에는 들어간다
  assert.equal(kv.m.get(hourKey(T)), "600");
  assert.equal(await neuronsUsed(kv, 9000, T), 625);
});

test("시간이 바뀌면 지난 칸에 모아 둔 몫도 쓴다", async () => {
  _resetWindow(); _resetBatch();
  const kv = fakeKv();
  const h0 = Date.parse("2026-11-24T05:59:00Z");
  const h1 = Date.parse("2026-11-24T06:01:00Z");
  await addNeurons(kv, 0, 40, { now: h0 }); // 50 — 모아 두기만
  assert.equal(kv.m.get(hourKey(h0)), undefined);
  await addNeurons(kv, 0, 40, { now: h1 }); // 다음 시간 첫 요청 — 지난 칸 50 을 쓴다
  assert.equal(kv.m.get(hourKey(h0)), "50");
  assert.equal(kv.m.get(hourKey(h1)), undefined);
  assert.equal(await neuronsUsed(kv, 9000, h1), 100);
});

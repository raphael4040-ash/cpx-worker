// "18개월 전" 같은 시점 표현을 사람 말투로 바꾸고, 아이 나이(개월)는 그대로 두는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import { naturalDurations as n } from "../src/sampleCase.js";

test("naturalDurations: 1년 넘는 개월·하루 단위 시간을 말로 바꾼다", () => {
  assert.equal(n("18개월 전부터 서서히"), "1년 반 전부터 서서히");
  assert.equal(n("36개월 전"), "3년 전");
  assert.equal(n("14개월째"), "1년 2개월째");
  assert.equal(n("24시간 전, 배꼽 주위"), "하루 전, 배꼽 주위");
  assert.equal(n("48시간째"), "이틀째");
});

test("naturalDurations: 1년 안쪽, 애매한 시간, 아이 나이는 건드리지 않는다", () => {
  for (const t of ["8개월 전", "30시간 전", "생후 18개월", "걷기 13개월", "16개월에 걸었다", "18개월경부터"]) assert.equal(n(t), t);
});

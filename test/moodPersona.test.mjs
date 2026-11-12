import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase } from "../src/sampleCase.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));

test("기분 변화 카드: 갑상선기능저하증·우울증 지병이 붙지 않는다 — 둘 다 이 카드의 감별 진단이다", () => {
  const data = read("09-mood-change.json");
  const personas = read("personas.json");
  for (const sc of data.scenarios) {
    for (let i = 0; i < 150; i++) {
      const p = buildCase("09-mood-change", data, personas, sc.id).person;
      assert.ok(!["thyroid", "depress"].includes(p.illness.id), `${sc.id}: ${p.illness.label}`);
    }
  }
});

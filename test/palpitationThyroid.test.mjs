import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase } from "../src/sampleCase.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));

test("두근거림 카드: 어떤 시나리오에도 갑상선기능저하증(레보티록신) 지병이 붙지 않는다 — 감별을 흐린다", () => {
  const data = read("13-palpitation.json");
  const personas = read("personas.json");
  for (const sc of data.scenarios) {
    for (let i = 0; i < 150; i++) {
      const p = buildCase("13-palpitation", data, personas, sc.id).person;
      assert.notEqual(p.illness.id, "thyroid", sc.id);
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase } from "../src/sampleCase.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const personas = read("personas.json");

test("통풍 인물 카드는 여성에게 55세 하한(femaleMinAge)이 있다", () => {
  const gout = personas.backgroundIllness.find((x) => x.id === "gout");
  assert.equal(gout.femaleMinAge, 55);
  assert.equal(gout.minAge, 30);
});

test("여성 환자에게는 55세 미만에서 통풍이 뽑히지 않는다 (월경이상·월경통·질 분비물 카드 다수 추첨)", () => {
  for (const file of ["33-1-menstrual-abnormality", "33-2-dysmenorrhea", "39-vaginal-discharge"]) {
    const data = read(file + ".json");
    for (const sc of data.scenarios) {
      for (let i = 0; i < 80; i++) {
        const kase = buildCase(file, data, personas, sc.id);
        const p = kase.person;
        if (p.sex === "female" && p.age < 55) {
          assert.notEqual(p.illness.id, "gout", `${file}/${sc.id}: ${p.age}세 여성에게 통풍`);
        }
        assert.ok(!(kase.problems || []).some((x) => /illness-나이/.test(x)), `${file}/${sc.id}: ${kase.problems}`);
      }
    }
  }
});

test("남성은 30세부터 통풍이 가능하다 (제한이 남성에게 번지지 않는다)", () => {
  const data = read("01-chest-pain.json");
  let seen = false;
  for (let i = 0; i < 4000 && !seen; i++) {
    const p = buildCase("01-chest-pain", data, personas).person;
    if (p.sex === "male" && p.illness.id === "gout") seen = true;
  }
  assert.ok(seen, "남성에게 통풍이 한 번은 뽑혀야 한다");
});

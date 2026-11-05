import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";
import { buildSystemPrompt } from "../src/interviewPrompt.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const personas = read("personas.json");
const GYN_CARDS = ["33-1-menstrual-abnormality", "33-2-dysmenorrhea", "39-vaginal-discharge"];

test("gynHx 가 있는 카드는 면담 프롬프트에 산부인과력이 실린다 (산과력·피임·마지막 월경일)", () => {
  for (const file of GYN_CARDS) {
    const data = read(file + ".json");
    for (const sc of data.scenarios) {
      if (!sc.gynHx) continue;
      for (let i = 0; i < 5; i++) {
        const kase = buildCase(file, data, personas, sc.id);
        const prompt = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase: "history" });
        assert.match(prompt, /산부인과력\(gynHx/, `${file}/${sc.id}`);
        for (const key of Object.keys(sc.gynHx)) assert.ok(prompt.includes(`Q: ${key} -> A:`), `${sc.id}: ${key}`);
        assert.ok(!/\{\{/.test(prompt), `${sc.id}: 남은 슬롯`);
      }
    }
  }
});

test("gynHx 가 없는 카드의 프롬프트에는 산부인과력 구역이 없다", () => {
  const data = read("01-chest-pain.json");
  const kase = buildCase("01-chest-pain", data, personas);
  const prompt = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase: "history" });
  assert.ok(!prompt.includes("산부인과력"));
});

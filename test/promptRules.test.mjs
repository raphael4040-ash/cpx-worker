import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";
import { buildSystemPrompt } from "../src/interviewPrompt.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));

test("묶음 질문은 항목마다 카드대로 답하라는 규칙이 모든 단계 프롬프트에 있다", () => {
  const data = read("01-chest-pain.json");
  const personas = read("personas.json");
  const kase = buildCase("01-chest-pain", data, personas);
  for (const phase of ["history", "pe", "all"]) {
    const prompt = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase });
    assert.match(prompt, /여러 가지를 묶어 물으면/, phase);
    assert.match(prompt, /뭉뚱그려 빼먹지 않는다/, phase);
    assert.match(prompt, /묶음 끝에 "다른 증상은요\?"/, phase);
    assert.match(prompt, /중간 항목만 건너뛰지 않는다/, phase);
    assert.match(prompt, /"다른 건 없어요"라고 단정하지 말고/, phase);
  }
});

test("요약·마무리 확인에서는 증상을 다시 나열하거나 묻지 않은 것을 덧붙이지 않는다는 규칙이 있다", () => {
  const data = read("01-chest-pain.json");
  const kase = buildCase("01-chest-pain", data, read("personas.json"));
  const hist = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase: "history" });
  assert.match(hist, /요약을\s+확인받을 때는 "네, 맞아요\."/);
  const pe = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase: "pe" });
  assert.match(pe, /새 걱정·증상·질문을 덧붙이지 않는다/);
});

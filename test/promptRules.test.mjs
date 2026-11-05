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
  }
});

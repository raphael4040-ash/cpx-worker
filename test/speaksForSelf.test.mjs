import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";
import { buildSystemPrompt } from "../src/interviewPrompt.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const personas = read("personas.json");

// 의식장애 환자(GCS 8~13)는 성인이어도 본인이 답하지 못한다 — 보호자가 답해야 한다.
test("의식장애 카드: 성인이어도 환자 본인 응답 불가, ICE 는 보호자 것", () => {
  const data = read("36-altered-consciousness.json");
  for (const sc of data.scenarios) {
    for (let i = 0; i < 5; i++) {
      const kase = buildCase("36-altered-consciousness", data, personas, sc.id);
      assert.equal(kase.person.speaksForSelf, false, sc.id);
      assert.equal(kase.person.iceOwner, "보호자", sc.id);
      const p = buildSystemPrompt(caseToPrompt(kase), { noPE: false, procedure: false, phase: "history" });
      assert.ok(p.includes("환자 본인 응답 불가"), sc.id);
    }
  }
});

test("보호자 동반이라도 표시가 없으면 13세 이상은 본인이 답한다 (기억력 저하)", () => {
  const data = read("10-memory-loss.json");
  const sc = data.scenarios.find((s) => s.informant);
  const kase = buildCase("10-memory-loss", data, personas, sc.id);
  assert.equal(kase.person.speaksForSelf, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";
import { buildSystemPrompt } from "../src/interviewPrompt.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const personas = read("personas.json");
const prompt = (file, data, id) =>
  buildSystemPrompt(caseToPrompt(buildCase(file, data, personas, id)), { noPE: false, procedure: false, phase: "history" });

// 일부 카드에만 있는 질문-답 묶음이 면담 프롬프트에 실려야 한다.
// (산전 진찰 obHx 가 빠져 마지막 월경일을 물으면 "잘 모르겠어요"라고 답했다.)
test("obHx·dischargeHx·dietActivity·peds·safetyAssessment 가 프롬프트에 실린다", () => {
  const keys = ["obHx", "dischargeHx", "dietActivity", "peds", "safetyAssessment"];
  let seen = 0;
  for (const f of readdirSync(dir).filter((x) => /^\d.*\.json$/.test(x))) {
    const file = f.replace(/\.json$/, "");
    const data = read(f);
    for (const sc of data.scenarios || []) {
      const present = keys.filter((k) => sc[k] && typeof sc[k] === "object");
      if (!present.length) continue;
      const p = prompt(file, data, sc.id);
      for (const k of present) {
        assert.ok(p.includes(`(${k}`), `${sc.id}: ${k} 구역 없음`);
        for (const q of Object.keys(sc[k])) {
          if (/^학생/.test(q)) assert.ok(!p.includes(`Q: ${q} ->`), `${sc.id}: 의사 할 일이 실림`);
          else assert.ok(p.includes(`Q: ${q} -> A:`), `${sc.id}: ${k}.${q}`);
        }
        seen++;
      }
      assert.ok(!/\{\{/.test(p), `${sc.id}: 남은 슬롯`);
    }
  }
  assert.ok(seen >= 10);
});

test("산전 진찰 카드는 마지막 월경일 답을 갖는다", () => {
  const data = read("24-prenatal-care.json");
  for (const sc of data.scenarios) {
    if (!sc.obHx?.["마지막 월경일"]) continue;
    assert.match(prompt("24-prenatal-care", data, sc.id), /Q: 마지막 월경일 -> A: \S/);
  }
});

test("coverStory·stage 가 프롬프트에 실린다", () => {
  const dv = read("02-1-domestic-violence.json");
  const sc = dv.scenarios.find((s) => s.coverStory);
  assert.ok(prompt("02-1-domestic-violence", dv, sc.id).includes("처음 둘러대는 설명"));
  const im = read("32-immunization.json");
  const st = im.scenarios.find((s) => s.stage);
  assert.ok(prompt("32-immunization", im, st.id).includes(`변화 단계(stage`));
});

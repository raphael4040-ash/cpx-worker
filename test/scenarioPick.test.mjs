import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pickScenarioId, EXAM_SETS } from "../src/scenarioPick.js";
test("모의고사 세트: 정답 질환 모드는 관리자가 아니어도 세트의 시나리오로 연다", () => {
  const sc = [{ id: "mood-mdd" }, { id: "mood-bipolar" }];
  assert.deepEqual(pickScenarioId({ examSet: "icm", examMode: "answer" }, false, sc, "09-mood-change"), { scenarioId: "mood-mdd" });
  // 감별부터 모드·세트 밖 주제·정답 미정 주제는 무작위
  assert.deepEqual(pickScenarioId({ examSet: "icm", examMode: "differential" }, false, sc, "09-mood-change"), { scenarioId: undefined });
  assert.deepEqual(pickScenarioId({ examSet: "icm", examMode: "answer" }, false, sc, "01-chest-pain"), { scenarioId: undefined });
  assert.deepEqual(pickScenarioId({ examSet: "icm", examMode: "answer" }, false, [{ id: "bru-itp" }], "29-easy-bruising"), { scenarioId: undefined });
  // 학생이 scenarioId 를 직접 보내도 여전히 무시
  assert.deepEqual(pickScenarioId({ scenarioId: "mood-bipolar" }, false, sc, "09-mood-change"), { scenarioId: undefined });
});
test("모의고사 세트의 정답 시나리오가 모두 카드에 있다", () => {
  for (const [file, id] of Object.entries(EXAM_SETS.icm)) {
    const d = JSON.parse(fs.readFileSync(new URL(`../src/cases/${file}.json`, import.meta.url), "utf8"));
    if (id) assert.ok(d.scenarios.some((s) => s.id === id), `${file} 에 ${id} 없음`);
  }
});

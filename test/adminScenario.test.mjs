import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickScenarioId, scenarioList } from "../src/scenarioPick.js";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";

const dir = new URL("../src/cases/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const data = read("33-1-menstrual-abnormality.json");
const personas = read("personas.json");

test("scenarioList: 월경이상 시나리오 목록에 id 와 진단명이 있다", () => {
  const list = scenarioList(data.scenarios);
  assert.ok(list.length >= 8);
  assert.ok(list.every((s) => s.id && s.dx));
  assert.ok(list.some((s) => s.id === "men-prolactinoma"));
});

test("관리자는 scenarioId 로 시나리오를 고정한다", () => {
  const pick = pickScenarioId({ scenarioId: "men-prolactinoma" }, true, data.scenarios);
  assert.equal(pick.scenarioId, "men-prolactinoma");
  for (let i = 0; i < 6; i++) {
    const kase = buildCase("33-1-menstrual-abnormality", data, personas, pick.scenarioId);
    assert.equal(caseToPrompt(kase).scenario.id, "men-prolactinoma");
  }
});

test("관리자가 아니면 scenarioId 는 무시된다 (정답 고르기 방지)", () => {
  for (const body of [{ scenarioId: "men-prolactinoma" }, { scenarioId: "nope" }, {}, null]) {
    assert.deepEqual(pickScenarioId(body, false, data.scenarios), { scenarioId: undefined });
  }
});

test("관리자라도 id 를 안 주면 무작위, 모르는 id 면 unknown_scenario", () => {
  assert.deepEqual(pickScenarioId({}, true, data.scenarios), { scenarioId: undefined });
  assert.deepEqual(pickScenarioId({ scenarioId: "" }, true, data.scenarios), { scenarioId: undefined });
  assert.equal(pickScenarioId({ scenarioId: "nope" }, true, data.scenarios).error.error, "unknown_scenario");
});

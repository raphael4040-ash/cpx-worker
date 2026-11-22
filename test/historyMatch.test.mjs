// 정형 문진 질문(이름·나이·직업·술·담배·약 알레르기)을 모델 없이 답하는 매칭 테스트.  cd cpx-worker && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { historyFacts, historyReply } from "../src/historyMatch.js";
import { buildCase, caseToPrompt } from "../src/sampleCase.js";

const F = { name: "황상철", age: 53, job: "요양보호사", smoke: "never", alcohol: "none", allergyNone: true };

test("정형 질문 하나씩 — 카드 값 그대로, 사람 말로", () => {
  assert.equal(historyReply("성함이랑 나이 말씀해 주시겠어요?", F), "황상철이고요, 53살이에요.");
  assert.equal(historyReply("성함이 어떻게 되세요?", F), "황상철이에요.");
  assert.equal(historyReply("하시는 일이 뭐예요?", F), "요양보호사로 일해요.");
  assert.equal(historyReply("담배 피우세요?", F), "아뇨, 담배는 안 피워요.");
  assert.equal(historyReply("술은 얼마나 드세요?", F), "술은 안 마셔요.");
  assert.equal(historyReply("약 알레르기 있으세요?", F), "아뇨, 알레르기는 없어요.");
  assert.equal(historyReply("술, 담배는 하세요?", F), "술도 안 마시고 담배도 안 피워요.");
  // 인사와 신원 확인을 한 번에 하면 인사부터
  assert.equal(historyReply("안녕하세요, 저는 의사 김민수입니다. 성함과 나이 확인 부탁드립니다.", F), "안녕하세요. 황상철이고요, 53살이에요.");
});

test("술과 담배를 함께 물으면 담배 문장에 주어가 붙는다", () => {
  const f = { ...F, smoke: "light", alcohol: "social" };
  assert.equal(historyReply("술, 담배 하세요?", f), "일주일에 한 번 정도, 소주 반 병쯤 마셔요. 담배는 하루에 반 갑씩 피워요. 10년쯤 됐어요.");
});

test("다른 내용이 섞이거나 정해 두지 않은 항목이면 모델에 넘긴다 (null)", () => {
  for (const q of [
    "무슨 일로 오셨어요?", // 내원 이유
    "술 마시면 더 아파요?", // 악화 요인
    "가족 중에 술 많이 드시는 분 있어요?", // 가족력
    "생년월일 말씀해 주세요.", // 월·일은 모델이 정한다
    "담배는 언제부터 피우셨어요?", // 기간
    "담배 끊으실 생각은 있으세요?", // 상담
    "드시는 약이나 알레르기 있으세요?", // 복용약이 섞임
    "어디가 불편해서 오셨어요?",
  ])
    assert.equal(historyReply(q, F), null, q);
  // 카드 값이 따로라 정해 두지 않은 항목(null)은 넘긴다
  assert.equal(historyReply("담배 피우세요?", { ...F, smoke: null }), null);
  assert.equal(historyReply("술, 담배 하세요?", { ...F, alcohol: null }), null);
  assert.equal(historyReply("약 알레르기 있으세요?", { ...F, allergyNone: false }), null);
  assert.equal(historyReply("성함이 어떻게 되세요?", null), null);
});

test("모든 카드: 보호자 케이스는 값을 두지 않고, 정형 답은 카드 값과 맞으며, 다른 질문은 잡지 않는다", () => {
  const dir = new URL("../src/cases/", import.meta.url);
  const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const personas = read("personas.json");
  const notOurs = ["무슨 일로 오셨어요?", "술 마시면 더 아파요?", "생년월일 말씀해 주세요.", "담배는 언제부터 피우셨어요?", "가족 중에 담배 피우는 분 있어요?"];
  for (const f of readdirSync(dir).filter((x) => /^\d.*\.json$/.test(x))) {
    const key = f.replace(/\.json$/, "");
    const data = read(f);
    if (!data.scenarios || !data.scenarios[0].hpi) continue;
    for (let i = 0; i < 4; i++) {
      const kase = buildCase(key, data, personas);
      const rc = caseToPrompt(kase);
      const fx = historyFacts(kase, rc, key);
      if (kase.person.guardian) {
        assert.equal(fx, null, key);
        continue;
      }
      for (const q of notOurs) assert.equal(historyReply(q, fx), null, `${key}: ${q}`);
      if (fx.smoke) assert.equal(fx.smoke, kase.person.smoking.id, key);
      if (fx.alcohol) assert.equal(fx.alcohol, kase.person.alcohol.id, key);
      if (/^(17|35-1|35-2)-/.test(key)) assert.ok(!fx.smoke && !fx.alcohol, `${key}: 술·담배 주제는 모델이 답한다`);
      if (fx.allergyNone) assert.match(String(rc.scenario.allergy || "없음"), /^없음/, key);
    }
  }
});

test("짜증형·의심형 등은 술·담배를 모델에 넘기고, 이름·직업은 그대로 답한다", () => {
  const kase = (pid) => ({
    person: { name: "배미숙", age: 36, occupation: { label: "식당 주방" }, personality: { id: pid }, smoking: { id: "never" }, alcohol: { id: "social" } },
  });
  const rc = { scenario: { sh: "직업 식당 주방 · 흡연 비흡연 · 음주 일주일에 한 번, 소주 반 병", allergy: "없음" }, person: {} };
  for (const pid of ["irritable", "suspicious", "minimizer", "guilty"]) {
    const fx = historyFacts(kase(pid), rc, "11-cough");
    assert.equal(fx.smoke, null, pid);
    assert.equal(fx.alcohol, null, pid);
    assert.equal(historyReply("하시는 일이 뭐예요?", fx), "식당 주방에서 일해요.", pid);
  }
  const ok = historyFacts(kase("cooperative"), rc, "11-cough");
  assert.equal(ok.smoke, "never");
  assert.equal(ok.alcohol, "social");
});

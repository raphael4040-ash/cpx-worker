/**
 * 관리자 점검용 시나리오 지정. 관리자가 아니면 body.scenarioId 는 무시하고 무작위(undefined)로 둔다 —
 * 학생이 정답 시나리오를 골라 연습하지 못하게 하는 서버 쪽 방어선이다.
 * 반환: { scenarioId } (undefined 면 무작위) 또는 { error }.
 */
/**
 * 모의고사 문제 세트 — 시험에 나왔던 주제와 그때의 정답 질환(시나리오 id).
 * 모의고사의 "정답 질환으로" 모드에서만 쓴다. 학생이 시나리오를 직접 고르는 것이 아니라 세트가 정한 것이라
 * 관리자가 아니어도 받는다. 정답이 아직 정해지지 않은 주제는 null — 그 주제는 무작위로 뽑는다.
 * 사이트(cpx-tracker docs/interview.js EXAM_SETS)의 주제 목록과 같아야 한다.
 */
export const EXAM_SETS = {
  icm: {
    "09-mood-change": "mood-mdd",
    "13-palpitation": "pal-af",
    "11-cough": "cou-uacs",
    "23-hematuria": "hu-iga-nephropathy",
    "26-1-polyuria": "pu-hyperglycemia",
    "40-weight-loss": "wl-hyperthyroid",
    "07-vomiting": "vom-pud-goo",
    "16-back-pain": "back-stenosis",
    "33-1-menstrual-abnormality": "men-endometrial-polyp",
    "29-easy-bruising": null, // 정답 미정 (2026-11-28) — 정해지면 시나리오 id 를 넣는다
  },
};

export function pickScenarioId(body, admin, scenarios, fileKey = "") {
  // 모의고사 "정답 질환으로" — 세트에 든 주제면 세트가 정한 시나리오로 연다.
  if (body && body.examMode === "answer" && typeof body.examSet === "string") {
    const set = EXAM_SETS[body.examSet];
    const id = set && fileKey ? set[fileKey] : undefined;
    if (id && scenarios.some((s) => s.id === id)) return { scenarioId: id };
  }
  if (!admin || !body || typeof body.scenarioId !== "string" || !body.scenarioId) return { scenarioId: undefined };
  if (!scenarios.some((s) => s.id === body.scenarioId)) return { error: { error: "unknown_scenario" } };
  return { scenarioId: body.scenarioId };
}

/** 점검 화면용 목록 [{id, dx}]. */
export function scenarioList(scenarios) {
  return scenarios.map((s) => ({ id: s.id, dx: s.dx || s.situation || s.id }));
}

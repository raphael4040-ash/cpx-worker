/**
 * 관리자 점검용 시나리오 지정. 관리자가 아니면 body.scenarioId 는 무시하고 무작위(undefined)로 둔다 —
 * 학생이 정답 시나리오를 골라 연습하지 못하게 하는 서버 쪽 방어선이다.
 * 반환: { scenarioId } (undefined 면 무작위) 또는 { error }.
 */
export function pickScenarioId(body, admin, scenarios) {
  if (!admin || !body || typeof body.scenarioId !== "string" || !body.scenarioId) return { scenarioId: undefined };
  if (!scenarios.some((s) => s.id === body.scenarioId)) return { error: { error: "unknown_scenario" } };
  return { scenarioId: body.scenarioId };
}

/** 점검 화면용 목록 [{id, dx}]. */
export function scenarioList(scenarios) {
  return scenarios.map((s) => ({ id: s.id, dx: s.dx || s.situation || s.id }));
}

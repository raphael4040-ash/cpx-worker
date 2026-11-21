/**
 * KV 쓰기 묶기. 무료 플랜 KV 는 하루 쓰기 1,000회가 한도다. 예전에는 면담 한 턴마다 뉴런 카운터·
 * Gemini 요청 카운터·면담별 사용량을 각각 썼고(면담 한 번에 35~40회), 2026-11-21 점검 중에 한도를
 * 넘겨 그날 남은 시간 동안 모든 면담 시작(세션 저장)이 실패했다.
 *
 * 카운터는 워커 인스턴스 메모리에 모았다가 일정량이 차면 한 번에 쓴다. 한도 판단은 KV 값에 아직
 * 안 쓴 몫을 더해서 한다. 인스턴스가 내려가면 안 쓴 몫은 사라진다 — 카운터가 조금 덜 세어지는
 * 쪽이고, 뉴런을 실제로 넘기면 Cloudflare 오류를 받아 그날 상한으로 고정하는 기존 처리가 남아 있다.
 * 면담 대화와 케이스(세션)는 여기와 무관하다.
 */

export const NEURON_FLUSH = 300; // 모인 뉴런이 이만큼 되면 쓴다 (모델 턴 몇 번 분량)
export const GEM_FLUSH = 5; // Gemini 요청이 이만큼 모이면 쓴다
export const USAGE_FLUSH_TURNS = 5; // 면담별 사용량은 몇 턴마다 쓴다 (첫 턴·평가 턴은 바로)

const pending = new Map(); // KV 키 → 아직 쓰지 않은 증가분

/** 이 인스턴스에 모여 있고 아직 KV 에 쓰지 않은 증가분. */
export function pendingFor(key) {
  return pending.get(key) || 0;
}

/**
 * 카운터를 delta 만큼 올린다. base 는 이번 요청이 읽은 KV 값.
 * 모인 몫이 flushAt 이상이거나 force 면 base + 모인 몫을 쓰고 비운다. 쓰기 실패는 다음에 다시 시도한다.
 */
export async function addCounter(kv, key, base, delta, flushAt, { force = false, ttl = 2 * 86400 } = {}) {
  const total = pendingFor(key) + (delta || 0);
  if (!total) return;
  if (!force && total < flushAt) {
    pending.set(key, total);
    return;
  }
  try {
    await kv.put(key, String(base + total), { expirationTtl: ttl });
    pending.delete(key);
  } catch {
    pending.set(key, total);
  }
}

/** 카운터 키의 쓰지 않은 몫을 버린다 (상한으로 못박을 때). */
export function dropPending(key) {
  pending.delete(key);
}

const usageCache = new Map(); // 면담별 사용량 키 → 최신 객체 (이 인스턴스가 본 것)

/** 면담별 사용량을 언제 쓸지 — 첫 턴(관리자 화면에 면담이 보이게), 평가 턴, 그리고 몇 턴마다. */
export function shouldFlushUsage(u, phase) {
  const turns = (u.modelTurns || 0) + (u.localTurns || 0);
  return turns === 1 || phase === "eval" || turns % USAGE_FLUSH_TURNS === 0;
}

export function cachedUsage(key) {
  return usageCache.get(key) || null;
}

export function rememberUsage(key, u) {
  usageCache.set(key, u);
  // 오래된 면담은 잊는다 — 인스턴스 메모리를 키우지 않게.
  if (usageCache.size > 500) usageCache.delete(usageCache.keys().next().value);
}

/** 테스트용 — 모은 상태를 비운다. */
export function _resetBatch() {
  pending.clear();
  usageCache.clear();
}

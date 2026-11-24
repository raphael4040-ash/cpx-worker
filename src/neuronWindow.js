/**
 * Workers AI 뉴런 사용량 — "최근 24시간" 기준으로 센다.
 *
 * 처음에는 무료 한도(10,000 뉴런)가 UTC 자정에 초기화된다고 보고 날짜별 카운터를 썼다. 그런데 Cloudflare 가
 * 그날 사용량이 3,000 남짓일 때도 "하루 10,000 을 다 썼다"(4006)를 냈다. 2026-11-23·24 두 번 모두, 그날 0시 이후가
 * 아니라 직전 24시간 합계가 10,000 근처였다 (Cloudflare 사용량 분석과 서버가 남긴 4006 기록으로 확인).
 * 그래서 시간(UTC)별 칸에 나눠 쌓고, 지금 시간 칸과 앞의 24칸(25칸 — 걸치는 시간까지 넉넉히)을 더해 판단한다.
 *
 * KV 쓰기는 예전과 같다 (모아 두었다가 한 번에 — kvBatch.js). 읽기는 지금 시간 칸만 매번 읽고, 지난 칸은
 * 인스턴스 메모리에 몇 분 동안 둔다 (지난 칸은 거의 바뀌지 않는다).
 */
import { addCounter, pendingFor, NEURON_FLUSH } from "./kvBatch.js";

export const WINDOW_HOURS = 25; // 지금 시간 칸 + 앞 24칸
// 우리가 세는 뉴런(응답 usage 로 계산)이 Cloudflare 집계보다 13~29% 적었다 (2026-11-23·24). 카운터에는 이만큼 늘려 쌓는다.
export const NEURON_CORRECTION = 1.25;
const PAST_CACHE_MS = 5 * 60 * 1000;
const BUCKET_TTL = 2 * 86400;

export const hourKey = (ms) => `ai:neurons:h:${new Date(ms).toISOString().slice(0, 13)}`;
export const HOLD_KEY = "ai:neurons:hold";

/** 창에 드는 시간 칸 키 — 오래된 것부터, 마지막이 지금 시간 칸. */
export function windowKeys(now = Date.now()) {
  const h = Math.floor(now / 3600000) * 3600000;
  const out = [];
  for (let i = WINDOW_HOURS - 1; i >= 0; i--) out.push(hourKey(h - i * 3600000));
  return out;
}

/** 카운터에 쌓을 양 — 보정 계수를 곱해 올림. */
export function corrected(neurons) {
  return neurons > 0 ? Math.ceil(neurons * NEURON_CORRECTION) : 0;
}

/**
 * 칸별 값(오래된 것부터, windowKeys 와 같은 순서)으로 언제 새 면담을 다시 시작할 수 있는지.
 * 오래된 칸부터 빠질 때 합계 + reserve 가 cap 이하가 되는 첫 시각. 지금도 되면 null.
 */
export function freeAt(values, cap, reserve, now = Date.now()) {
  let total = values.reduce((s, v) => s + v, 0);
  if (total + reserve <= cap) return null;
  const h = Math.floor(now / 3600000) * 3600000;
  for (let i = 0; i < values.length; i++) {
    total -= values[i];
    // i 번째 칸(지금부터 WINDOW_HOURS-1-i 시간 전)은 그 칸 시작 + WINDOW_HOURS 시간에 창에서 빠진다.
    if (total + reserve <= cap) return new Date(h - (WINDOW_HOURS - 1 - i) * 3600000 + WINDOW_HOURS * 3600000).toISOString();
  }
  return new Date(h + WINDOW_HOURS * 3600000).toISOString();
}

const pastCache = new Map(); // 지난 시간 칸 키 → { v, at }

async function readInt(kv, key) {
  try {
    return parseInt((await kv.get(key)) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

/** 창의 칸별 값 (KV 값 + 이 인스턴스에 모아 둔 몫). 마지막이 지금 시간 칸. */
export async function windowValues(kv, now = Date.now()) {
  const keys = windowKeys(now);
  const cur = keys[keys.length - 1];
  return Promise.all(
    keys.map(async (k) => {
      let v;
      if (k === cur) v = await readInt(kv, k);
      else {
        const c = pastCache.get(k);
        if (c && now - c.at < PAST_CACHE_MS) v = c.v;
        else {
          v = await readInt(kv, k);
          pastCache.set(k, { v, at: now });
        }
      }
      return v + pendingFor(k);
    })
  ).finally(() => {
    for (const k of pastCache.keys()) if (!keys.includes(k)) pastCache.delete(k);
  });
}

/** 최근 24시간 사용량. Cloudflare 4006 으로 잠시 멈춘 동안에는 cap 으로 본다. */
export async function neuronsUsed(kv, cap, now = Date.now()) {
  if (await kv.get(HOLD_KEY)) return cap;
  return (await windowValues(kv, now)).reduce((s, v) => s + v, 0);
}

/** 이 요청에서 쓴 뉴런을 지금 시간 칸에 쌓는다. base = 이번 요청이 읽은 지금 칸 KV 값. */
export async function addNeurons(kv, base, neurons, { force = false, now = Date.now() } = {}) {
  return addCounter(kv, hourKey(now), base, corrected(neurons), NEURON_FLUSH, { force, ttl: BUCKET_TTL });
}

/** 지금 시간 칸의 KV 값 (addNeurons 의 base). */
export async function currentBase(kv, now = Date.now()) {
  return readInt(kv, hourKey(now));
}

/** 테스트용. */
export function _resetWindow() {
  pastCache.clear();
}

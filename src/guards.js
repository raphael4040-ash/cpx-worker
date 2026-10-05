/**
 * 워커 공통 방어 — CORS 허용 목록과 IP 레이트리밋. 런타임 의존(KV·fetch)이 없어서
 * test/guards.test.mjs 가 그대로 import 해 검증한다.
 */

// 웹 기록판이 서비스되는 주소. 새 주소와, 이미 공유된 링크용 옛 주소, 로컬 개발 서버(.claude/launch.json 의 8123).
// 바꾸려면 wrangler.toml 의 ALLOWED_ORIGINS(쉼표로 구분)에 적는다.
const DEFAULT_ORIGINS = [
  "https://cpx-practice.github.io",
  "https://raphael4040-ash.github.io",
  "http://localhost:8123",
  "http://127.0.0.1:8123",
];

export function allowedOrigins(env) {
  const raw = env && env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

/**
 * 이 요청에 붙일 CORS 헤더. 허용 목록에 있는 Origin 만 그대로 되돌려 준다 — 그 외 사이트의 스크립트는
 * 브라우저가 응답을 읽지 못한다. Origin 헤더가 없는 호출(플러그인 훅의 curl 등)은 CORS 와 상관없이 그대로 통한다.
 */
export function corsFor(request, env) {
  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/**
 * IP 당 창 하나에 요청 수를 센다. KV 가 없거나 IP 를 못 얻거나 KV 가 실패하면 통과시킨다(가용성 우선).
 * prefix 로 경로별 카운터를 나눈다 — 면담 시작(iv)과 AI 면담 시작(aiStart)이 서로 한도를 갉아먹지 않게.
 */
export async function checkRateLimit(kv, ip, { prefix = "iv", max = 20, windowSec = 600 } = {}) {
  if (!kv || !ip) return true;
  const key = `${prefix}:${ip}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return true; // KV 읽기 실패로 정상 사용자를 막지 않는다
  }
  if (count >= max) return false;
  try {
    await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  } catch {
    /* 카운트 저장에 실패해도 이번 요청은 이미 허용됐다 */
  }
  return true;
}

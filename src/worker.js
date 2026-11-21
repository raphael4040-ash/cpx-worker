/**
 * CPXpert 면담 워커 (Cloudflare Workers)
 *
 * 하는 일:
 *   1. /interview/start   — 케이스를 뽑아 본인 키(Gemini)용 시스템 프롬프트를 내준다 (interviewRoutes.js)
 *   2. /interview/ai/*    — "키 없이" 면담: Workers AI·운영자 Gemini 로 환자를 연기하고 채점한다 (aiRoutes.js)
 *
 * 예전에는 Claude Code 플러그인의 Stop 훅이 보낸 채점 결과를 기록하는 /upload 도 있었다.
 * 플러그인을 폐기하면서 2026-11-21 에 없앴다 (연결 코드·tokenVersion 도 함께 쓰지 않는다).
 */
import { handleInterviewStart } from "./interviewRoutes.js";
import { handleAiStart, handleAiChat, handleAiHandoff, handleAiStatus, handleAiUsage, handleAiKeys, handleAiLimits, handleAiScenarios } from "./aiRoutes.js";
import { corsFor, checkRateLimit } from "./guards.js";

// Cloudflare 대시보드에서 환경변수(FIREBASE_PROJECT_ID)를 넣으면 그 값이 우선하고,
// 안 넣으면 아래 기본값을 쓴다. 웹앱에 그대로 노출되는 공개 식별자라 코드에 박아둬도 안전하다.
const DEFAULT_PROJECT_ID = "cpx-tracker";

// 기록판 주인(관리자)의 uid. firestore.rules 의 ownerUid() 와 반드시 같아야 한다.
const DEFAULT_OWNER_UID = "S4b2Zqzff2XHNznL1Wcq6RiZVGv1";

// 배포된 워커가 최신인지 밖에서 확인하기 위한 버전 문자열.
// 이 파일을 고칠 때마다 함께 올린다 — 그래야 `curl .../health` 로 붙었는지 판별된다.
const WORKER_VERSION = "2026-11-21.1";

// CORS 헤더는 요청마다 guards.js 의 corsFor 가 만든다 (허용 목록에 있는 Origin 만 통과).

// /interview/start 는 로그인이 필요 없다 — 학생 브라우저가 세션을 시작하기 전부터 부르는
// 경로라서다. 그만큼 인증 없이 열려 있어, 외부에서 스크립트로 반복 호출하면 Cloudflare 무료
// 한도(하루 10만 요청)를 실제 학생 몫까지 갉아먹을 수 있다. env.RATE_LIMIT_KV 가 설정돼 있을
// 때만 IP 당 창 하나에 요청 수를 센다 — KV 바인딩을 아직 안 만든 배포(로컬 dev 등)에서는
// 그냥 통과시킨다(가용성을 우선한다). 기본값(창 10분, IP 당 20회)은 guards.js 의 checkRateLimit 에 있다.

// 키 없는 AI 면담 시작은 로그인이 필요하고 1인당 하루 횟수도 있지만, 계정을 여러 개 만들어 우회할 수 있다.
// 그래서 IP 당으로도 센다. 학교처럼 한 IP 에 학생이 몰려도 되게 넉넉히 잡았다.
const AI_START_LIMIT = { prefix: "aiStart", max: 30, windowSec: 600 };
// 계정별 키 보관(/interview/ai/keys) — 로그인 때 한 번 읽고 저장할 때 쓰므로 넉넉히 잡았다.
const AI_KEYS_LIMIT = { prefix: "aiKeysIp", max: 120, windowSec: 600 };

export default {
  async fetch(request, env) {
    const CORS = corsFor(request, env);
    // json() 은 CORS 를 모르는 곳에서도 쓰이므로, 응답이 나가기 직전에 한 번에 붙인다.
    const res = await handle(request, env, CORS);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  },
};

async function handle(request, env, CORS) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, version: WORKER_VERSION });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // 웹 면담(본인 키) — 케이스 조합·프롬프트 생성만 여기서 하고, 실제 Gemini 호출은 브라우저가
    // 직접 한다(Worker→Google 경로가 구글 지역 차단에 걸려서). 별도 파일(interviewRoutes.js).
    if (url.pathname === "/interview/start") {
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const allowed = await checkRateLimit(env.RATE_LIMIT_KV, ip);
      if (!allowed) {
        return json({ error: "rate_limited", hint: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
      }
      return await handleInterviewStart(request, env, CORS);
    }
    // "키 없이 바로" 면담 — Workers AI 무료 한도 안에서만 돈다 (aiRoutes.js 참고).
    if (url.pathname.startsWith("/interview/ai/")) {
      const cfg = {
        projectId: env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID,
        ownerUid: env.OWNER_UID || DEFAULT_OWNER_UID,
      };
      if (url.pathname === "/interview/ai/status") return await handleAiStatus(env, CORS);
      if (url.pathname === "/interview/ai/start") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (!(await checkRateLimit(env.RATE_LIMIT_KV, ip, AI_START_LIMIT))) {
          return json({ error: "rate_limited", hint: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
        }
        return await handleAiStart(request, env, cfg, CORS);
      }
      if (url.pathname === "/interview/ai/keys") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (!(await checkRateLimit(env.RATE_LIMIT_KV, ip, AI_KEYS_LIMIT))) {
          return json({ error: "rate_limited", hint: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
        }
        return await handleAiKeys(request, env, cfg, CORS);
      }
      if (url.pathname === "/interview/ai/chat") return await handleAiChat(request, env, cfg, CORS);
      if (url.pathname === "/interview/ai/handoff") return await handleAiHandoff(request, env, cfg, CORS);
      if (url.pathname === "/interview/ai/usage") return await handleAiUsage(request, env, cfg, CORS);
      if (url.pathname === "/interview/ai/limits") return await handleAiLimits(request, env, cfg, CORS);
      if (url.pathname === "/interview/ai/scenarios") return await handleAiScenarios(request, env, cfg, CORS);
    }
    return json({ error: "not_found" }, 404);
  } catch (err) {
    return json({ error: "internal", detail: String((err && err.message) || err) }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }, // CORS 헤더는 fetch 진입점에서 붙인다
  });
}

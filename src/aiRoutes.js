/**
 * 웹 면담 — "키 없이 바로" 모드 (Cloudflare Workers AI).
 *
 * 학생이 API 키를 따로 발급받지 않아도 되도록, 운영자 계정의 Workers AI 무료 한도
 * (하루 10,000 뉴런, UTC 00:00 = 한국 09:00 에 초기화)로 환자 역할을 돌린다.
 * 무료 한도를 넘기면 안 되므로 세 겹으로 막는다:
 *
 *   1. 하루 총량 — 실제로 쓴 뉴런(응답의 usage 로 계산)을 KV 에 누적해서
 *      AI_DAILY_NEURON_CAP(기본 9,000 — 10,000 에서 KV 동시성 오차 여유분을 뺀 값)에
 *      닿으면 그날은 더 안 부른다. 새 면담은 "한 회 분량"이 남아 있을 때만 시작시킨다
 *      (중간에 끊기는 것보다 시작을 막는 편이 낫다).
 *   2. 1인당 하루 면담 수 — AI_USER_DAILY_SESSIONS(기본 2). 한 사람이 그날 몫을 다
 *      가져가지 않게 한다. 로그인한 기록판 계정 uid 기준이다.
 *   3. 요청 크기 — 대화 길이·글자 수 상한. 이 엔드포인트를 범용 무료 LLM 으로 쓰지
 *      못하도록 시스템 프롬프트는 서버가 KV 에 들고 있고, 브라우저는 세션 id 만 보낸다.
 *
 * KV 는 결과적 일관성이라 동시에 여러 요청이 오면 카운트가 조금 덜 셀 수 있다 — 그래서
 * 상한을 10,000 이 아니라 9,000 으로 잡았다. 무료 플랜 계정이면 10,000 을 넘는 순간
 * Cloudflare 가 알아서 에러를 내므로 과금은 생기지 않는다(그때도 아래에서 같은 안내로 바꿔 보여준다).
 */
import { handleInterviewStart } from "./interviewRoutes.js";
import { sanitizeMessages, neuronsFor, extractReply } from "./aiLimits.js";

// 한국어 환자 연기 품질·뉴런 단가를 같이 보고 고른 기본값. wrangler.toml 의 AI_MODEL 로 바꾼다.
const DEFAULT_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const FREE_NEURONS_PER_DAY = 10000;
const DEFAULT_DAILY_CAP = 9000;
const DEFAULT_USER_DAILY_SESSIONS = 2;
// 면담 한 회(문진 30턴 + 진찰 + 평가)에 드는 뉴런 추정치 — gemma-4 기준 약 2,000.
// 남은 양이 이보다 적으면 새 면담을 시작시키지 않는다.
const DEFAULT_SESSION_RESERVE = 2000;

const SESSION_TTL_SEC = 3 * 60 * 60;
const MAX_OUTPUT_TOKENS = 4096;

// ---------------------------------------------------------------- 공개 핸들러

/** POST /interview/ai/start — 케이스를 뽑고 세션을 KV 에 만든다. */
export async function handleAiStart(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!env.AI || !kv) return json({ error: "ai_not_configured" }, 503, cors);

  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);

  const limits = readLimits(env);
  const day = utcDay();
  const used = await getInt(kv, `ai:neurons:${day}`);
  if (used + limits.reserve > limits.cap) {
    return json({ error: "daily_budget_exhausted", resetsAt: nextResetIso() }, 429, cors);
  }
  const userKey = `ai:user:${day}:${user.uid}`;
  const userSessions = await getInt(kv, userKey);
  if (user.uid !== cfg.ownerUid && userSessions >= limits.perUser) {
    return json({ error: "user_daily_limit", limit: limits.perUser, resetsAt: nextResetIso() }, 429, cors);
  }

  // 케이스 조합은 기존 /interview/start 그대로 재사용한다 (같은 바디 형식).
  const startRes = await handleInterviewStart(request, env, cors);
  if (!startRes.ok) return startRes;
  const data = await startRes.json();

  const sessionId = crypto.randomUUID();
  await kv.put(
    `ai:session:${sessionId}`,
    JSON.stringify({ uid: user.uid, systemPrompt: data.systemPrompt, topic: data.topic }),
    { expirationTtl: SESSION_TTL_SEC }
  );
  await kv.put(userKey, String(userSessions + 1), { expirationTtl: 2 * 86400 });

  return json(
    {
      sessionId,
      topic: data.topic,
      model: env.AI_MODEL || DEFAULT_AI_MODEL,
      // 채점이 끝난 뒤 카드에 케이스 이름을 보여줄 때만 쓴다. 시스템 프롬프트는 내려주지 않는다.
      remainingToday: Math.max(0, limits.perUser - userSessions - 1),
    },
    200,
    cors
  );
}

/** POST /interview/ai/chat — {sessionId, messages:[{role:"user"|"assistant", text}]} */
export async function handleAiChat(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!env.AI || !kv) return json({ error: "ai_not_configured" }, 503, cors);

  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  const messages = sanitizeMessages(body?.messages);
  if (!messages) return json({ error: "bad_messages" }, 400, cors);

  const session = await kv.get(`ai:session:${String(body.sessionId || "")}`, "json");
  if (!session || session.uid !== user.uid) return json({ error: "session_expired" }, 404, cors);

  const limits = readLimits(env);
  const day = utcDay();
  const neuronKey = `ai:neurons:${day}`;
  const used = await getInt(kv, neuronKey);
  if (used >= limits.cap) {
    return json({ error: "daily_budget_exhausted", resetsAt: nextResetIso() }, 429, cors);
  }

  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  let result;
  try {
    result = await env.AI.run(model, {
      messages: [
        { role: "system", content: session.systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.text })),
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.8,
      // 사고(reasoning) 출력은 환자 대사에 필요 없고 출력 뉴런만 늘린다.
      chat_template_kwargs: { enable_thinking: false },
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    // 무료 플랜에서 10,000 뉴런을 넘기면 Cloudflare 가 에러를 낸다 — 우리 카운터가
    // 덜 셌던 경우다. 그날은 상한에 닿은 것으로 기록해 이후 요청을 미리 막는다.
    if (/neuron|daily|quota|limit|4006/i.test(msg)) {
      await kv.put(neuronKey, String(limits.cap), { expirationTtl: 2 * 86400 });
      return json({ error: "daily_budget_exhausted", resetsAt: nextResetIso() }, 429, cors);
    }
    return json({ error: "ai_error", detail: msg.slice(0, 300) }, 502, cors);
  }

  const reply = extractReply(result);
  const spent = neuronsFor(model, result?.usage, session.systemPrompt, messages, reply);
  await kv.put(neuronKey, String(used + spent), { expirationTtl: 2 * 86400 });

  if (!reply) return json({ error: "empty_response" }, 502, cors);
  return json({ reply, neurons: spent }, 200, cors);
}

/** GET 대신 POST /interview/ai/status — 오늘 남은 양 (설정 화면 안내용, 인증 불필요). */
export async function handleAiStatus(env, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!env.AI || !kv) return json({ enabled: false }, 200, cors);
  const limits = readLimits(env);
  const used = await getInt(kv, `ai:neurons:${utcDay()}`);
  return json(
    {
      enabled: true,
      model: env.AI_MODEL || DEFAULT_AI_MODEL,
      usedNeurons: used,
      capNeurons: limits.cap,
      canStart: used + limits.reserve <= limits.cap,
      perUserDaily: limits.perUser,
      resetsAt: nextResetIso(),
    },
    200,
    cors
  );
}

// ---------------------------------------------------------------- 인증

/**
 * 브라우저가 보낸 Firebase ID token 으로 본인 확인을 한다.
 * 토큰의 uid 로 Firestore users/{uid} 를 그 토큰으로 읽어보면, 위조 토큰은 Firestore 가
 * 401/403 으로 거부하므로 서명 검증 라이브러리 없이도 진짜인지 가려진다.
 * 기록판과 같은 승인제(config/app.requireApproval)를 따른다.
 */
async function authenticate(request, cfg) {
  const auth = request.headers.get("Authorization") || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!idToken) return { error: "login_required", status: 401 };

  let uid = "";
  try {
    const payload = JSON.parse(b64urlDecode(idToken.split(".")[1] || ""));
    uid = payload.user_id || payload.sub || "";
    if (payload.aud && payload.aud !== cfg.projectId) return { error: "bad_token", status: 401 };
  } catch {
    return { error: "bad_token", status: 401 };
  }
  if (!uid) return { error: "bad_token", status: 401 };

  const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${idToken}` };
  const res = await fetch(`${base}/users/${uid}`, { headers });
  if (res.status === 401 || res.status === 403) return { error: "bad_token", status: 401 };

  let approved = false;
  if (res.ok) approved = (await res.json())?.fields?.approved?.booleanValue === true;
  if (uid !== cfg.ownerUid && !approved) {
    const conf = await fetch(`${base}/config/app`, { headers });
    const required = conf.ok && (await conf.json())?.fields?.requireApproval?.booleanValue === true;
    if (required) return { error: "not_approved", status: 403 };
  }
  return { uid };
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function readLimits(env) {
  const num = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  return {
    cap: Math.min(num(env.AI_DAILY_NEURON_CAP, DEFAULT_DAILY_CAP), FREE_NEURONS_PER_DAY),
    perUser: num(env.AI_USER_DAILY_SESSIONS, DEFAULT_USER_DAILY_SESSIONS),
    reserve: num(env.AI_SESSION_RESERVE, DEFAULT_SESSION_RESERVE),
  };
}

async function getInt(kv, key) {
  try {
    return parseInt((await kv.get(key)) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

// Workers AI 무료 한도는 UTC 자정에 초기화된다 — 카운터 날짜도 UTC 로 맞춘다.
function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function nextResetIso(d = new Date()) {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return n.toISOString();
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

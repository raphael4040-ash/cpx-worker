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
import { prepareInterview, SAFETY_SETTINGS } from "./interviewRoutes.js";
import { normalizePut, seal, open as openStored, MAX_BODY_CHARS } from "./aiKeyStore.js";
import { geminiConfigured, geminiModel, callGemini, isGeminiQuotaError, isGeminiDayQuota, probeGemini } from "./geminiBackend.js";
import { matchFindings, vitalsReply, findingsReply } from "./peMatch.js";
import { sanitizeMessages, neuronsFor, tokenCounts, extractReply, withTurnReminder, phaseFor, looksLikeEvaluation, withNotYetEvalNote, FEEDBACK_SYSTEM, feedbackOnlyMessages, insertFeedback, isOpeningTurn, withTimeout, parseUserLimit, validUid, MAX_USER_LIMIT } from "./aiLimits.js";

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
const MAX_TURN_TOKENS = 512;
const AI_CALL_TIMEOUT_MS = 40000;
// Gemini 폴백 — 무료 한도는 모델마다 다르고 바뀐다. 우리 쪽 상한은 사실상 풀어 두고(wrangler.toml 로 줄일 수 있다),
// 실제 한도는 구글이 돌려주는 429(PerDay)로 알아낸다 — 그날은 `ai:gem:dead:{day}` 로 표시해 새 면담을 막는다.
const DEFAULT_GEMINI_SESSIONS = 1000;
const DEFAULT_GEMINI_REQUESTS = 100000;

// ---------------------------------------------------------------- 공개 핸들러

/** POST /interview/ai/start — 케이스를 뽑고 세션을 KV 에 만든다. */
export async function handleAiStart(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!env.AI || !kv) return json({ error: "ai_not_configured" }, 503, cors);

  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);

  // 케이스 조합은 /interview/start 와 같은 함수를 쓴다 (같은 바디 형식).
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* 빈 바디 허용 — 무작위 케이스 */
  }

  const limits = readLimits(env);
  const day = utcDay();
  const used = await getInt(kv, `ai:neurons:${day}`);
  // 뉴런이 모자라면 운영자 Gemini 키가 있을 때만 그쪽으로 시작한다. 면담 도중에는 제공자를 바꾸지 않는다.
  let backend = "workers";
  // 관리자 점검용 — 뉴런이 남아 있어도 Gemini 로 시작해 본다 (본인 토큰이 관리자일 때만, 키가 있을 때만).
  if (body?.forceGemini === true && user.uid === cfg.ownerUid && geminiConfigured(env)) backend = "gemini";
  else if (used + limits.reserve > limits.cap) {
    if (!(await geminiHasRoom(kv, env, day))) {
      return json({ error: "daily_budget_exhausted", resetsAt: nextResetIso() }, 429, cors);
    }
    backend = "gemini";
  }
  const userKey = `ai:user:${day}:${user.uid}`;
  const userSessions = await getInt(kv, userKey);
  // 관리자가 계정별로 정해 둔 하루 면담 횟수가 있으면 그것을, 없으면 기본값을 쓴다 (handleAiLimits).
  const userLimit = (await getUserLimit(kv, user.uid)) ?? limits.perUser;
  if (user.uid !== cfg.ownerUid && userSessions >= userLimit) {
    return json({ error: "user_daily_limit", limit: userLimit, resetsAt: nextResetIso() }, 429, cors);
  }

  const prepared = prepareInterview(body);
  if (prepared.error) return json(prepared.error, prepared.status, cors);
  // 단계별 프롬프트를 미리 만들어 둔다 — 매 턴 그 단계에 필요한 만큼만 보낸다 (phaseFor 참고).
  const prompts = { history: prepared.prompt("history"), pe: prepared.prompt("pe"), eval: prepared.prompt("eval") };
  // 두 AI 가 모두 소진됐을 때 학생 본인 키로 이어가려면(handleAiHandoff) 단계 구분 없는 전체 프롬프트가 필요하다.
  prompts.all = prepared.prompt("all");

  const sessionId = crypto.randomUUID();
  await kv.put(
    `ai:session:${sessionId}`,
    JSON.stringify({ uid: user.uid, backend, prompts, topic: prepared.topic, pe: prepared.pe, openings: prepared.openings }),
    { expirationTtl: SESSION_TTL_SEC }
  );
  await kv.put(userKey, String(userSessions + 1), { expirationTtl: 2 * 86400 });
  if (backend === "gemini") {
    await kv.put(`ai:gem:sessions:${day}`, String((await getInt(kv, `ai:gem:sessions:${day}`)) + 1), { expirationTtl: 2 * 86400 });
  }

  return json(
    {
      sessionId,
      topic: prepared.topic,
      model: backend === "gemini" ? geminiModel(env) : env.AI_MODEL || DEFAULT_AI_MODEL,
      // 채점이 끝난 뒤 카드에 케이스 이름을 보여줄 때만 쓴다. 시스템 프롬프트는 내려주지 않는다.
      remainingToday: Math.max(0, userLimit - userSessions - 1),
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
  // 배포 직후 남아 있던 예전 세션(통짜 systemPrompt)도 그대로 돌게 한다.
  const systemPrompt = session.prompts ? session.prompts[phaseFor(messages)] : session.systemPrompt;

  const sessionId = String(body.sessionId);
  // 첫 대사는 카드에 고정돼 있다 — 내원 이유를 처음 물으면 모델 없이 후보 중 하나를 낸다.
  if (phaseFor(messages) === "history" && isOpeningTurn(messages, session.openings)) {
    const opening = session.openings[Math.floor(Math.random() * session.openings.length)];
    const usage = await recordUsage(kv, sessionId, session.topic, "history", 0, true, undefined, session.backend, session.uid);
    return json({ reply: opening, neurons: 0, usage }, 200, cors);
  }

  // 진찰 단계는 소견이 이미 확정돼 있어서, 학생이 한 진찰 동작이 소견 이름과 확실히 맞으면
  // 모델 없이 바로 답한다 (뉴런 0). 애매하면 아래로 내려가 지금처럼 모델이 답한다.
  if (phaseFor(messages) === "pe" && session.pe) {
    const last = messages[messages.length - 1].text;
    let local = null;
    if (/^\s*진찰\s*$/.test(last)) local = vitalsReply(session.pe.vitals);
    else {
      const hit = matchFindings(last, session.pe.findings);
      if (hit) local = findingsReply(hit, session.pe.vitals);
    }
    if (local) {
      const usage = await recordUsage(kv, sessionId, session.topic, "pe", 0, true, undefined, session.backend, session.uid);
      return json({ reply: local, neurons: 0, usage }, 200, cors);
    }
  }

  const limits = readLimits(env);
  const day = utcDay();
  const neuronKey = `ai:neurons:${day}`;
  const used = await getInt(kv, neuronKey);
  let gemini = session.backend === "gemini";
  let model = gemini ? geminiModel(env) : env.AI_MODEL || DEFAULT_AI_MODEL;
  const gemReqKey = `ai:gem:req:${day}`;
  const gemDeadKey = `ai:gem:dead:${day}`;
  const gemOk = async () => geminiConfigured(env) && !(await getInt(kv, gemDeadKey)) && (await getInt(kv, gemReqKey)) < geminiLimits(env).maxRequests;
  let workersOk = used < limits.cap;
  const exhausted = () => json({ error: "daily_budget_exhausted", resetsAt: nextResetIso() }, 429, cors);
  // 진행 중인 면담도 한쪽이 소진되면 다른 쪽으로 넘긴다 (대화 전체를 매번 보내는 구조라 이어서 할 수 있다). 둘 다 소진돼야 막힌다.
  const switchTo = async (toGemini) => {
    gemini = toGemini;
    model = gemini ? geminiModel(env) : env.AI_MODEL || DEFAULT_AI_MODEL;
    session.backend = gemini ? "gemini" : "workers";
    try {
      await kv.put(`ai:session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SEC });
    } catch {
      /* 저장 실패해도 이번 요청은 그대로 진행 */
    }
  };
  if (gemini && !(await gemOk())) {
    if (!workersOk) return exhausted();
    await switchTo(false);
  } else if (!gemini && !workersOk) {
    if (!(await gemOk())) return exhausted();
    await switchTo(true);
  }

  const phase = phaseFor(messages);
  // Workers AI 호출이 응답 없이 걸리는 일이 실제로 있었다 (브라우저에는 입력 중 표시만 계속 돌았다).
  // 한 번에 AI_CALL_TIMEOUT_MS 를 넘기면 포기하고 ai_timeout 으로 알린다. 호출 자체는 취소되지 않는다.
  const callTimeoutMs = Number(env.AI_CALL_TIMEOUT_MS) || AI_CALL_TIMEOUT_MS;
  let gemCalls = 0;
  const run = (msgs, system = systemPrompt) =>
    gemini
      ? (gemCalls++,
        withTimeout(
          callGemini(env, {
            system,
            msgs,
            maxTokens: phase === "eval" ? MAX_OUTPUT_TOKENS : MAX_TURN_TOKENS,
            temperature: 0.8,
          }),
          callTimeoutMs
        ))
      : withTimeout(
      env.AI.run(model, {
        messages: [{ role: "system", content: system }, ...msgs.map((m) => ({ role: m.role, content: m.text }))],
        // 문진·진찰 답은 한두 문장이다. 상한을 낮춰 두면 장황한 답과 지연이 준다. 평가만 길다.
        max_completion_tokens: phase === "eval" ? MAX_OUTPUT_TOKENS : MAX_TURN_TOKENS,
        temperature: 0.8,
        // 사고(reasoning) 출력은 환자 대사에 필요 없고 출력 뉴런만 늘린다.
        chat_template_kwargs: { enable_thinking: false },
      }),
      callTimeoutMs
    );

  let spent = 0;
  let tokIn = 0; // 이 요청에서 쓴 입력·출력 토큰 — 면담별 사용량(recordUsage)에 남긴다
  let tokOut = 0;
  const count = (usage, system, msgs, text) => {
    const t = tokenCounts(usage, system, msgs, text);
    tokIn += t.tin;
    tokOut += t.tout;
    return gemini ? 0 : neuronsFor(model, usage, system, msgs, text); // Gemini 는 뉴런을 쓰지 않는다
  };
  const saveCounters = async () => {
    if (spent) await kv.put(neuronKey, String(used + spent), { expirationTtl: 2 * 86400 });
    if (gemCalls) await kv.put(gemReqKey, String((await getInt(kv, gemReqKey)) + gemCalls), { expirationTtl: 2 * 86400 });
  };
  let reply = "";
  let capped = false; // 이번 요청에서 Workers AI 카운터를 상한으로 못박았는가 (아래 마지막 저장이 덮어쓰지 않게)
  const attempt = async () => {
    const turn = withTurnReminder(messages, systemPrompt);
    let result = await run(turn);
    reply = extractReply(result);
    spent += count(result?.usage, systemPrompt, turn, reply);
    // "평가" 전인데 평가문을 쓴 경우 — 학생의 요약·마무리 말에서 실제로 있었다 (기록 블록 없이,
    // 환자 말풍선 안에). 한 번은 안내를 덧붙여 다시 받고, 그래도 평가면 중립 지문으로 대신한다.
    if (phase !== "eval" && looksLikeEvaluation(reply)) {
      const retry = withNotYetEvalNote(turn);
      result = await run(retry);
      reply = extractReply(result);
      spent += count(result?.usage, systemPrompt, retry, reply);
      if (looksLikeEvaluation(reply)) reply = "(환자가 고개를 끄덕입니다.)";
    }
    // 평가에 개선점이 빠지는 일이 있었다 (Gemma 4 — 채점표와 기록 블록만 내고 잘한 점·개선점을 통째로 생략).
    // 평가 프롬프트 전체를 다시 보내지 않고, 짧은 지시와 대화·채점표만 보내 개선점만 받아 끼운다.
    if (phase === "eval" && !/개선점/.test(reply)) {
      try {
        const ask = feedbackOnlyMessages(messages, reply);
        const again = await run(ask, FEEDBACK_SYSTEM);
        const text = extractReply(again);
        spent += count(again?.usage, FEEDBACK_SYSTEM, ask, text);
        if (text) reply = insertFeedback(reply, text);
      } catch {
        /* 다시 받기가 실패해도 처음 평가는 그대로 돌려준다 */
      }
    }
  };
  for (let pass = 0; ; pass++) {
    try {
      await attempt();
      break;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (msg === "ai_timeout") {
        await saveCounters();
        return json({ error: "ai_timeout" }, 504, cors);
      }
      if (gemini && isGeminiQuotaError(msg)) {
        await saveCounters();
        // 하루 한도가 찼으면 그날은 Gemini 로 새 면담을 시작하지 않고, Workers AI 에 여유가 있으면 이 면담을 거기서 이어간다.
        // 분당 한도면 잠깐 뒤 다시 하면 되므로 503(클라이언트가 재시도)로 알린다.
        if (isGeminiDayQuota(msg)) {
          await kv.put(gemDeadKey, "1", { expirationTtl: 2 * 86400 });
          if (pass === 0 && workersOk) {
            await switchTo(false);
            gemCalls = 0;
            continue;
          }
          return exhausted();
        }
        return json({ error: "ai_busy" }, 503, cors);
      }
      // 무료 플랜에서 10,000 뉴런을 넘기면 Cloudflare 가 에러를 낸다 — 우리 카운터가
      // 덜 셌던 경우다. 그날은 상한에 닿은 것으로 기록해 이후 요청을 미리 막고, Gemini 에 여유가 있으면 거기서 이어간다.
      if (!gemini && /neuron|daily|quota|limit|4006/i.test(msg)) {
        await kv.put(neuronKey, String(limits.cap), { expirationTtl: 2 * 86400 });
        capped = true;
        workersOk = false;
        if (pass === 0 && (await gemOk())) {
          await switchTo(true);
          spent = 0;
          continue;
        }
        return exhausted();
      }
      await saveCounters();
      return json({ error: "ai_error", detail: msg.slice(0, 300) }, 502, cors);
    }
  }
  if (spent && !capped) await kv.put(neuronKey, String(used + spent), { expirationTtl: 2 * 86400 });
  if (gemCalls) await kv.put(gemReqKey, String((await getInt(kv, gemReqKey)) + gemCalls), { expirationTtl: 2 * 86400 });

  const usage = await recordUsage(kv, sessionId, session.topic, phase, spent, false, { tin: tokIn, tout: tokOut }, gemini ? "gemini" : "workers", session.uid);
  if (!reply) return json({ error: "empty_response" }, 502, cors);
  return json({ reply, neurons: spent, usage }, 200, cors);
}

/**
 * POST /interview/ai/handoff — {sessionId}. 두 AI(Workers AI·운영자 Gemini)가 모두 소진돼 면담이 끊기게 됐을 때,
 * 학생이 본인 키로 같은 면담을 이어갈 수 있게 전체 시스템 프롬프트를 내려준다. 평소에는 내려주지 않는다
 * (소진이 확인된 경우에만, 그리고 그 세션의 주인에게만).
 */
export async function handleAiHandoff(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!kv) return json({ error: "ai_not_configured" }, 503, cors);
  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  const session = await kv.get(`ai:session:${String(body?.sessionId || "")}`, "json");
  if (!session || session.uid !== user.uid) return json({ error: "session_expired" }, 404, cors);
  const day = utcDay();
  const limits = readLimits(env);
  const workersDone = (await getInt(kv, `ai:neurons:${day}`)) >= limits.cap;
  const gemDone =
    !geminiConfigured(env) || !!(await getInt(kv, `ai:gem:dead:${day}`)) || (await getInt(kv, `ai:gem:req:${day}`)) >= geminiLimits(env).maxRequests;
  if (!(workersDone && gemDone)) return json({ error: "not_exhausted" }, 409, cors);
  if (!session.prompts?.all) return json({ error: "no_handoff" }, 409, cors);
  return json({ systemPrompt: session.prompts.all, topic: session.topic, safetySettings: SAFETY_SETTINGS }, 200, cors);
}

/**
 * POST /interview/ai/keys — 계정별 AI 키 보관 (면담 탭의 "내 계정에 키 저장").
 *   {action:"get"}                                  → {aiKeys, aiModels, aiProvider} (저장된 게 없으면 {})
 *   {action:"put", aiKeys, aiModels, aiProvider}    → {ok:true}
 *   {action:"delete"}                               → {ok:true}
 * 본인 토큰으로만 본인 것을 읽고 쓴다. 관리자도 다른 사람의 키를 이 경로로는 못 읽는다(uid 가 토큰에서 나온다).
 * 검증·암호화는 aiKeyStore.js (KEY_ENCRYPTION_SECRET 이 있으면 암호화).
 */
export async function handleAiKeys(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!kv) return json({ error: "ai_not_configured" }, 503, cors);

  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);

  let text;
  try {
    text = await request.text();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  if (text.length > MAX_BODY_CHARS) return json({ error: "too_large" }, 413, cors);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }

  const key = `aikeys:${user.uid}`;
  if (body?.action === "get") {
    try {
      return json((await openStored(await kv.get(key), env.KEY_ENCRYPTION_SECRET, user.uid)) || {}, 200, cors);
    } catch {
      return json({ error: "unreadable" }, 500, cors); // 암호화된 값인데 비밀값이 바뀌었거나 없는 경우
    }
  }
  if (body?.action === "delete") {
    await kv.delete(key);
    return json({ ok: true }, 200, cors);
  }
  if (body?.action === "put") {
    const data = normalizePut(body);
    if (!data) return json({ error: "bad_keys" }, 400, cors);
    await kv.put(key, await seal({ ...data, updatedAt: new Date().toISOString() }, env.KEY_ENCRYPTION_SECRET, user.uid));
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "bad_action" }, 400, cors);
}

/** 관리자가 정해 둔 계정별 하루 면담 횟수. 없으면 null. */
async function getUserLimit(kv, uid) {
  try {
    return parseUserLimit(await kv.get(`ai:limit:${uid}`));
  } catch {
    return null;
  }
}

/**
 * POST /interview/ai/limits — 관리자 전용. 계정별 하루 면담 횟수를 정한다 (전체 무료 뉴런 한도는 그대로 적용된다).
 *   {action:"list"}                       → {defaultLimit, maxLimit, limits:{uid:n}}
 *   {action:"set", uid, limit}            → {ok:true}   limit 이 null 이면 기본값으로 되돌린다
 * 사용자 문서(Firestore)가 아니라 KV 에 두는 이유: 사용자가 자기 문서에 값을 넣을 수 있어서, 관리자만 쓸 수 있는 곳이 필요하다.
 */
export async function handleAiLimits(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!kv) return json({ error: "ai_not_configured" }, 503, cors);
  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);
  if (user.uid !== cfg.ownerUid) return json({ error: "forbidden" }, 403, cors);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  if (body?.action === "list") {
    const out = {};
    const list = await kv.list({ prefix: "ai:limit:" });
    for (const k of list.keys) {
      const n = parseUserLimit(await kv.get(k.name));
      if (n !== null) out[k.name.slice("ai:limit:".length)] = n;
    }
    return json({ defaultLimit: readLimits(env).perUser, maxLimit: MAX_USER_LIMIT, limits: out }, 200, cors);
  }
  if (body?.action === "set") {
    if (!validUid(body.uid)) return json({ error: "bad_uid" }, 400, cors);
    if (body.limit === null || body.limit === undefined) {
      await kv.delete(`ai:limit:${body.uid}`);
      return json({ ok: true }, 200, cors);
    }
    const n = parseUserLimit(body.limit);
    if (n === null) return json({ error: "bad_limit", max: MAX_USER_LIMIT }, 400, cors);
    await kv.put(`ai:limit:${body.uid}`, String(n));
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "bad_action" }, 400, cors);
}

/**
 * POST /interview/ai/usage — 관리자 전용. 오늘(UTC) 면담별 사용량.
 * 하루 총량만으로는 면담 한 회에 실제로 얼마가 드는지, 모델 없이 답한 턴이 얼마나 되는지 알 수 없었다.
 */
export async function handleAiUsage(request, env, cfg, cors) {
  const kv = env.RATE_LIMIT_KV;
  if (!kv) return json({ error: "ai_not_configured" }, 503, cors);
  const user = await authenticate(request, cfg);
  if (user.error) return json({ error: user.error }, user.status, cors);
  if (user.uid !== cfg.ownerUid) return json({ error: "forbidden" }, 403, cors);
  const day = utcDay();
  let probe;
  try {
    const b = await request.clone().json();
    if (b && b.probe) probe = await probeGemini(env);
  } catch {
    /* 바디 없음 */
  }
  const list = await kv.list({ prefix: `ai:usage:${day}:` });
  const sessions = [];
  for (const k of list.keys) {
    const v = await kv.get(k.name, "json");
    if (v) sessions.push(v);
  }
  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const gem = {
    configured: geminiConfigured(env),
    model: geminiModel(env),
    sessions: await getInt(kv, `ai:gem:sessions:${day}`),
    requests: await getInt(kv, `ai:gem:req:${day}`),
    exhausted: (await getInt(kv, `ai:gem:dead:${day}`)) === 1,
    ...geminiLimits(env),
  };
  return json({ day, usedNeurons: await getInt(kv, `ai:neurons:${day}`), gemini: gem, probe, sessions }, 200, cors);
}

/** 면담 한 회의 사용량을 누적한다. 키에 날짜를 넣어 그날 것만 접두사로 나열할 수 있게 한다. */
async function recordUsage(kv, sessionId, topic, phase, neurons, local, tokens = { tin: 0, tout: 0 }, backend = "workers", uid = "") {
  const key = `ai:usage:${utcDay()}:${sessionId}`;
  let u = null;
  try {
    u = await kv.get(key, "json");
  } catch {
    /* 기록 실패는 면담을 막지 않는다 */
  }
  u = u || { sessionId, topic, backend, uid, startedAt: new Date().toISOString(), neurons: 0, modelTurns: 0, localTurns: 0, tokensIn: 0, tokensOut: 0, byPhase: {} };
  u.neurons += neurons;
  u.tokensIn = (u.tokensIn || 0) + tokens.tin; // 이 기능을 넣기 전의 기록에는 없으므로 || 0
  u.tokensOut = (u.tokensOut || 0) + tokens.tout;
  if (local) u.localTurns += 1;
  else u.modelTurns += 1;
  const p = (u.byPhase[phase] = u.byPhase[phase] || { neurons: 0, model: 0, local: 0 });
  p.neurons += neurons;
  p.tokensIn = (p.tokensIn || 0) + tokens.tin;
  p.tokensOut = (p.tokensOut || 0) + tokens.tout;
  p[local ? "local" : "model"] += 1;
  u.updatedAt = new Date().toISOString();
  try {
    await kv.put(key, JSON.stringify(u), { expirationTtl: 3 * 86400 });
  } catch {
    /* 기록 실패는 면담을 막지 않는다 */
  }
  return { neurons: u.neurons, modelTurns: u.modelTurns, localTurns: u.localTurns, tokensIn: u.tokensIn, tokensOut: u.tokensOut };
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
      canStart: used + limits.reserve <= limits.cap || (await geminiHasRoom(kv, env, utcDay())),
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

function geminiLimits(env) {
  const num = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  return {
    maxSessions: num(env.GEMINI_DAILY_SESSIONS, DEFAULT_GEMINI_SESSIONS),
    maxRequests: num(env.GEMINI_DAILY_REQUESTS, DEFAULT_GEMINI_REQUESTS),
  };
}

/** Gemini 폴백으로 새 면담을 시작할 여유가 있는지 (키가 있고, 하루 면담 수·요청 수가 남았을 때). */
async function geminiHasRoom(kv, env, day) {
  if (!geminiConfigured(env)) return false;
  const lim = geminiLimits(env);
  if (await getInt(kv, `ai:gem:dead:${day}`)) return false;
  const [sessions, reqs] = await Promise.all([getInt(kv, `ai:gem:sessions:${day}`), getInt(kv, `ai:gem:req:${day}`)]);
  return sessions < lim.maxSessions && reqs + 25 <= lim.maxRequests; // 면담 한 회 약 25~30회 호출
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

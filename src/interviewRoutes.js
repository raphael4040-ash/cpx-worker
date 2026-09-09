/**
 * 웹 면담(Gemini BYOK) 라우트.
 *
 * 학생이 자기 무료 Gemini API 키를 브라우저에 저장해두고 매 요청마다 실어 보낸다.
 * 이 Worker 는 그 키를 저장하지 않고 그 요청 처리에만 쓰고 버린다 — 케이스 정답
 * (dx·PE 소견)은 서버(KV)에만 있고 학생 브라우저에는 절대 내려가지 않는다.
 */
import { buildCase, caseToPrompt } from "./sampleCase.js";
import { buildSystemPrompt, pickOpening } from "./interviewPrompt.js";
import indexData from "./cases/index.json";
import personas from "./cases/personas.json";
import { CASES } from "./cases/manifest.js";

const SESSION_TTL = 60 * 60 * 2; // 2시간 — 면담 하나가 이보다 오래 걸리면 새로 시작
const MAX_TURNS = 60; // 학생 메시지 기준. 폭주(무한루프 등)로 본인 무료 할당량이 새는 것을 막는 안전장치
const DEFAULT_MODEL = "gemini-2.5-flash";

export async function handleInterviewStart(request, env, cors) {
  const apiKey = bearerToken(request);
  if (!apiKey) return json({ error: "missing_api_key" }, 401, cors);

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* 빈 바디 허용 — 무작위 케이스 */
  }

  const resolved = resolveTopic(body.topic);
  if (!resolved) {
    return json({ error: "unknown_topic", hint: "topics.js 의 표기와 일치해야 합니다" }, 400, cors);
  }
  if (resolved._procedureCase || resolved._noPhysicalExam) {
    // 술기 카드(situation·expectedSequence·distractors)와 "나쁜 소식 전하기"
    // (awareness·news·reactionStages)는 일반 hpi/redFlags/pe 스키마와 전혀 달라서
    // 이 프롬프트 빌더가 아직 다루지 않는다. 지금은 Claude Code 플러그인 전용으로
    // 남겨두고, 웹 면담에서는 명시적으로 막는다.
    return json({ error: "topic_not_supported", hint: "이 케이스는 아직 웹 면담에서 지원하지 않습니다" }, 400, cors);
  }

  const fileKey = resolved.file.replace(/\.json$/, "");
  const data = CASES[fileKey];
  if (!data) return json({ error: "case_not_bundled", file: resolved.file }, 500, cors);

  const kase = buildCase(fileKey, data, personas);
  if (kase.problems && kase.problems.length) {
    console.log("case build problems:", resolved.topicName, kase.problems);
  }
  const resolvedCase = caseToPrompt(kase);
  const systemPrompt = buildSystemPrompt(resolvedCase, {
    noPE: !!resolved._noPhysicalExam,
    procedure: !!resolved._procedureCase,
  });
  const opening = pickOpening(resolvedCase) || "안녕하세요...";

  const sessionId = newId();
  const session = {
    systemPrompt,
    topic: resolvedCase.topic,
    dx: resolvedCase.dx,
    history: [{ role: "model", parts: [{ text: opening }] }],
    turns: 0,
  };
  await env.INTERVIEW_SESSIONS.put(sessionId, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  });

  return json({ sessionId, topic: resolvedCase.topic, opening }, 200, cors);
}

export async function handleInterviewMessage(request, env, cors) {
  const apiKey = bearerToken(request);
  if (!apiKey) return json({ error: "missing_api_key" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  const { sessionId, message } = body || {};
  if (!sessionId || typeof message !== "string" || !message.trim()) {
    return json({ error: "bad_request" }, 400, cors);
  }

  const raw = await env.INTERVIEW_SESSIONS.get(sessionId);
  if (!raw) return json({ error: "session_expired" }, 410, cors);
  const session = JSON.parse(raw);

  if (session.turns >= MAX_TURNS) {
    return json({ error: "too_many_turns", hint: "이 면담은 길이 제한에 도달했습니다. 새로 시작해주세요." }, 429, cors);
  }

  session.history.push({ role: "user", parts: [{ text: message.slice(0, 4000) }] });

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let reply;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: session.systemPrompt }] },
        contents: session.history,
        generationConfig: { temperature: 0.8 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      const status = res.status === 429 ? 429 : 502;
      return json({ error: "gemini_error", status: res.status, detail: detail.slice(0, 500) }, status, cors);
    }
    const data = await res.json();
    reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!reply) {
      const blockReason = data?.promptFeedback?.blockReason;
      return json({ error: "empty_response", blockReason: blockReason || null }, 502, cors);
    }
  } catch (err) {
    return json({ error: "network_error", detail: String(err && err.message || err) }, 502, cors);
  }

  session.history.push({ role: "model", parts: [{ text: reply }] });
  session.turns += 1;

  const isEvaluation = /```cpx-record\s*\{/.test(reply);
  if (isEvaluation) {
    // 채점이 끝났다. 이후 대화는 새 세션으로 유도한다 — 여기서 만료시켜 KV 를 정리한다.
    await env.INTERVIEW_SESSIONS.delete(sessionId);
  } else {
    await env.INTERVIEW_SESSIONS.put(sessionId, JSON.stringify(session), {
      expirationTtl: SESSION_TTL,
    });
  }

  return json({ reply, topic: session.topic, done: isEvaluation }, 200, cors);
}

// ---------------------------------------------------------------- helpers

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function newId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** topic 이 비어 있으면 무작위, 있으면 index.json 의 aliases 를 거쳐 찾는다. */
function resolveTopic(input) {
  const topics = indexData.topics;
  if (!input) {
    // 술기 카드·나쁜 소식 전하기는 무작위 풀에서도 뺀다 (아래 topic_not_supported 안내 참고).
    const keys = Object.keys(topics).filter((k) => !topics[k]._procedureCase && !topics[k]._noPhysicalExam);
    const name = keys[Math.floor(Math.random() * keys.length)];
    return { topicName: name, ...topics[name] };
  }
  const canonical = topics[input] ? input : indexData.aliases[input];
  if (!canonical || !topics[canonical]) return null;
  return { topicName: canonical, ...topics[canonical] };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

/**
 * 운영자 Gemini 키 폴백 — Workers AI 무료 뉴런이 떨어졌을 때 새 면담을 Gemini 무료 한도로 돌린다.
 *
 * 키는 Worker 시크릿 GEMINI_API_KEY 로만 들어가고 브라우저로 나가지 않는다.
 * 응답은 Workers AI 결과와 같은 모양({response, usage:{prompt_tokens, completion_tokens}})으로 바꿔 돌려줘서
 * extractReply·tokenCounts 를 그대로 쓴다.
 *
 * 주의: 예전에 Gemini 호출을 Worker 안에서 하다가 구글의 지역 차단("User location is not supported")에
 * 걸려 브라우저 직접 호출로 옮긴 적이 있다 (git log: b812ce2). 그래서 probeGemini 로 실제로 닿는지 확인할 수 있게 해 둔다.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiConfigured(env) {
  return typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 10;
}

export function geminiModel(env) {
  return env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/** Workers AI 형식의 messages([{role, content}], 첫 항목이 system)를 Gemini 요청 바디로 바꾼다. */
export function toGeminiBody(system, msgs, { maxTokens, temperature }) {
  const contents = [];
  for (const m of msgs) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    // 같은 역할이 연달아 오면 합친다 (Gemini 는 교대를 기대한다).
    if (last && last.role === role) last.parts[0].text += "\n" + m.text;
    else contents.push({ role, parts: [{ text: m.text }] });
  }
  if (contents.length && contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(시작)" }] });
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
}

/** Gemini 응답을 Workers AI 결과 모양으로 바꾼다. 차단·빈 응답은 빈 response 로 둔다. */
export function fromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  const u = data?.usageMetadata || {};
  return {
    response: text,
    usage: {
      prompt_tokens: u.promptTokenCount,
      // 사고 토큰도 출력으로 과금·집계된다.
      completion_tokens: Number.isFinite(u.candidatesTokenCount) ? u.candidatesTokenCount + (u.thoughtsTokenCount || 0) : undefined,
    },
  };
}

/** 한 번 호출. 실패하면 Error("gemini_<status>: <요약>") 를 던진다. fetchFn 은 테스트용. */
export async function callGemini(env, { system, msgs, maxTokens, temperature }, fetchFn = fetch) {
  const url = `${BASE}/models/${encodeURIComponent(geminiModel(env))}:generateContent`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(toGeminiBody(system, msgs, { maxTokens, temperature })),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message || "";
    } catch {
      /* 본문이 JSON 이 아니면 상태 코드만 쓴다 */
    }
    throw new Error(`gemini_${res.status}: ${String(detail).replace(/key=[^\s&]+/g, "key=***").slice(0, 200)}`);
  }
  return fromGeminiResponse(await res.json());
}

/** 오류가 한도 소진(429)인지. */
export function isGeminiQuotaError(msg) {
  return /^gemini_429/.test(String(msg));
}

/** 이 Worker 에서 Gemini 에 실제로 닿는지 확인한다 (모델 목록 조회 — 토큰을 쓰지 않는다). 관리자 진단용. */
export async function probeGemini(env, fetchFn = fetch) {
  if (!geminiConfigured(env)) return { configured: false };
  try {
    const res = await fetchFn(`${BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    let detail = "";
    if (!res.ok) {
      try {
        detail = (await res.json())?.error?.message || "";
      } catch {
        /* 무시 */
      }
    }
    return { configured: true, ok: res.ok, status: res.status, detail: String(detail).slice(0, 200), model: geminiModel(env) };
  } catch (err) {
    return { configured: true, ok: false, status: 0, detail: String((err && err.message) || err).slice(0, 200), model: geminiModel(env) };
  }
}

/**
 * "키 없이" 면담(aiRoutes.js)의 순수 계산 함수들. 런타임 의존(KV·AI·JSON import)이 없어서
 * test/aiLimits.test.mjs 가 그대로 import 해 검증한다.
 */

const MAX_USER_TURNS = 60;
const MAX_MESSAGE_CHARS = 1500;
const MAX_TOTAL_CHARS = 40000;

// 모델별 뉴런 단가 [입력, 출력] (100만 토큰당). https://developers.cloudflare.com/workers-ai/platform/pricing/
// 목록에 없는 모델은 보수적으로 비싼 쪽(FALLBACK_RATE)으로 센다.
const NEURON_RATES = {
  "@cf/google/gemma-4-26b-a4b-it": [9091, 27273],
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/openai/gpt-oss-20b": [18182, 27273],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
};
const FALLBACK_RATE = [40000, 300000];

export function sanitizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  let total = 0;
  let userTurns = 0;
  const out = [];
  for (const m of input) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
    const text = m.role === "user" ? m.text.slice(0, MAX_MESSAGE_CHARS) : m.text;
    total += text.length;
    if (m.role === "user") userTurns++;
    out.push({ role: m.role, text });
  }
  if (out[out.length - 1].role !== "user") return null;
  if (userTurns > MAX_USER_TURNS || total > MAX_TOTAL_CHARS) return null;
  return out;
}

/** usage 가 오면 그대로, 안 오면 글자 수로 보수적으로(한글 1자 ≈ 1토큰) 추정한다. */
export function neuronsFor(model, usage, systemPrompt, messages, reply) {
  const [rin, rout] = NEURON_RATES[model] || FALLBACK_RATE;
  let tin = usage?.prompt_tokens;
  let tout = usage?.completion_tokens;
  if (!Number.isFinite(tin)) tin = systemPrompt.length + messages.reduce((n, m) => n + m.text.length, 0);
  if (!Number.isFinite(tout)) tout = (reply || "").length;
  return Math.ceil((tin * rin + tout * rout) / 1e6);
}

export function extractReply(result) {
  const raw =
    result?.choices?.[0]?.message?.content ??
    (typeof result?.response === "string" ? result.response : "") ??
    "";
  // 사고 끄기가 무시되는 모델이 있어도 환자 대사에 <think> 가 섞이지 않게 한다.
  return String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}


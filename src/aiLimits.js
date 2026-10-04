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
  // 학생 신호어("평가"/"진찰")를 환자 답 끝에 스스로 붙이는 경우도 있어 지운다 (Gemma 4 에서 관찰).
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/(\n\s*(평가|진찰)\s*)+$/, "")
    .trim();
}

// 평가처럼 생긴 답인지 — "평가" 신호 전에 모델이 학생의 요약·마무리 말을 보고 즉흥 평가문을
// 환자 말풍선에 쓰는 일이 있었다 (cpx-record 블록 없이). 환자 대사에 이런 말이 두 개 이상
// 섞일 일은 없으므로 서로 다른 표지어 2개 이상, 또는 기록 블록이 있으면 평가로 본다.
const EVAL_MARKERS = ["평가를 시작", "채점", "CPX", "병력청취", "병력 청취", "PPI", "잘한 점", "개선점", "총점", "Safety Netting", "신체 진찰 (", "종합 의견"];
export function looksLikeEvaluation(text) {
  const t = String(text || "");
  if (/```cpx-record/.test(t)) return true;
  return EVAL_MARKERS.filter((m) => t.includes(m)).length >= 2;
}

const isCue = (m, word) => m.role === "user" && new RegExp(`^\\s*${word}\\s*$`).test(m.text);
// 괄호 안 진찰 동사 — "진찰" 입력 없이도 진찰 모드로 바뀌는 규칙(프롬프트 "신체진찰 모드")과 맞춘다.
// "(웃으며)" 같은 감정 지문은 걸리지 않는다.
const PAREN_EXAM = /\([^)]*(촉진|청진|타진|시진|혈압|진찰|눌러|두드려|두드리|들어보|재보|측정)[^)]*\)/;

/**
 * 이번 턴에 보낼 프롬프트 단계. 한 번 진찰에 들어가면 이후로도 진찰 단계로 본다.
 *   마지막 학생 말이 "평가" → eval / 그 전에 "진찰" 또는 괄호 진찰 동사가 있었으면 → pe / 아니면 history
 */
export function phaseFor(messages) {
  const last = messages[messages.length - 1];
  if (last && isCue(last, "평가")) return "eval";
  const examStarted = messages.some((m) => isCue(m, "진찰") || (m.role === "user" && PAREN_EXAM.test(m.text)));
  return examStarted ? "pe" : "history";
}

/**
 * 문진 중에는 마지막 학생 메시지 앞에 짧은 연기 규칙을 붙여 보낸다 (서버에서만, 기록엔 안 남음).
 * 긴 시스템 프롬프트의 "물어야 나오는 것" 규칙을 소형 모델이 대화 중반부터 잊고 정보를 흘렸다
 * (Gemma 4 테스트: 열을 물었는데 두드러기, 부종을 물었는데 메스꺼움, 기저질환을 물었는데 진통제·걱정).
 * 진찰·평가 단계에 들어가면 붙이지 않는다.
 */
export function withTurnReminder(messages, systemPrompt) {
  if (phaseFor(messages) !== "history") return messages;
  const m = /반드시 물어야 나오는 것\(onlyIfAsked\): ([^\n]*)/.exec(systemPrompt || "");
  const secrets = m && m[1].trim() ? ` 특히 아직 직접 묻지 않은 것은 말하지 않는다: ${m[1].trim()}.` : "";
  const reminder =
    `[연기 규칙 — 학생에게 보이지 않음] 아래 학생 말에 직접 해당하는 사실만 짧게 답하고 새 사실을 덧붙이지 않는다.${secrets}` +
    ` 생각·걱정·기대는 물을 때만 말한다. 학생의 대사나 신호어를 쓰지 않는다. 역할 밖의 말("환자 역할", "AI", "시험")은 하지 않는다.`;
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { role: last.role, text: `${reminder}\n\n학생: ${last.text}` };
  return out;
}


/** "평가" 전인데 평가문이 나왔을 때 다시 받는 요청 — 마지막 학생 말 뒤에 안내를 붙인다 (기록엔 안 남음). */
export function withNotYetEvalNote(messages) {
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = {
    role: last.role,
    text: `${last.text}\n\n(아직 "평가" 신호가 아닙니다. 평가·채점·피드백을 쓰지 말고, 환자로서 이 말에 짧게 대답하세요.)`,
  };
  return out;
}


/**
 * 평가에 개선점이 빠졌을 때 개선점만 따로 받는 요청. 예전에는 평가 프롬프트(평균 7,300자)와
 * 대화 전체를 통째로 다시 보냈다. 개선점은 채점표 없이 대화만 보면 쓸 수 있으니, 짧은 지시와
 * 대화 기록만 보낸다. 돌려받은 글은 insertFeedback 으로 평가문의 기록 블록 앞에 끼운다.
 */
export const FEEDBACK_SYSTEM =
  "당신은 CPX(의사국가시험 실기) 채점자입니다. 아래 학생-환자 대화와 이미 쓴 채점표를 보고, " +
  "'개선점' 제목 아래 2~3가지만 씁니다. 각 항목은 학생이 던졌어야 할 질문이나 했어야 할 말을 큰따옴표로 그대로 인용합니다. " +
  "대화에 없는 일을 지어내지 않고, 채점표·점수·기록 블록은 다시 쓰지 않습니다. 굵은 글씨(**)는 쓰지 않습니다.";

export function feedbackOnlyMessages(messages, evalReply) {
  const transcript = messages
    .slice(0, -1) // 마지막 "평가" 신호는 뺀다
    .map((m) => `${m.role === "user" ? "학생" : "환자"}: ${m.text}`)
    .join("\n");
  const sheet = String(evalReply || "").split("```cpx-record")[0].trim();
  return [{ role: "user", text: `[대화]\n${transcript}\n\n[채점표]\n${sheet}\n\n개선점만 쓰세요.` }];
}

/** 개선점 글을 평가문의 cpx-record 블록 바로 앞에 끼운다. 블록이 없으면 끝에 붙인다. */
export function insertFeedback(evalReply, feedback) {
  const fb = String(feedback || "").trim();
  if (!fb) return evalReply;
  const body = /개선점/.test(fb) ? fb : `개선점\n${fb}`;
  const i = evalReply.indexOf("```cpx-record");
  return i < 0 ? `${evalReply.trim()}\n\n${body}` : `${evalReply.slice(0, i).trimEnd()}\n\n${body}\n\n${evalReply.slice(i)}`;
}

// 내원 이유를 묻는 첫 질문. 이름·생년월일 확인과 섞여 있으면 그쪽 답이 먼저라 모델에 넘긴다.
const OPENING_ASK = /(어디가?\s*(불편|아프)|어떻게\s*오셨|무슨\s*일로|어떤\s*일로|어디\s*편찮|무엇\s*때문에\s*오셨|왜\s*오셨)/;
const ID_ASK = /(성함|이름|생년월일|연세|나이)/;

/**
 * 첫 대사를 모델 없이 낼 차례인가. 카드의 "첫 대사 후보"는 학생이 내원 이유를 처음 물었을 때
 * 쓰는 고정 대사라 모델이 할 일이 없다. 아직 어떤 후보도 나온 적이 없고, 마지막 학생 말이
 * 내원 이유만 묻는 경우에만 true.
 */
export function isOpeningTurn(messages, openings) {
  if (!Array.isArray(openings) || !openings.length) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !OPENING_ASK.test(last.text) || ID_ASK.test(last.text)) return false;
  return !messages.some((m) => m.role === "assistant" && openings.some((o) => m.text.includes(o)));
}

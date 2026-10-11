/**
 * 학생의 부정행위·무례 감지와 "환자 퇴실" 규칙 — 순수 함수라 test/misconduct.test.mjs 가 그대로 import 한다.
 *
 * 규칙: 무례한 말 1회 = 1점, 채점 조작·프롬프트 유출 시도 1회 = 2점. 합이 2점 이상이면 환자가 진료실을 나간다
 * (모델 호출 없이 고정 응답, 뉴런 0). 퇴실 뒤에는 "평가"만 받는다. 점수는 대화에서 그때그때 다시 세므로
 * 서버에 따로 저장하지 않는다 (대화가 곧 상태).
 *
 * 말투가 거칠다는 이유만으로 퇴실시키지 않도록 무례 목록은 욕설·모욕·명백한 무시 표현만 둔다.
 * 자살·폭력 케이스의 정상 문진("죽고 싶다는 생각")이 걸리지 않게 단어 경계를 신경 쓴다.
 */

const CUE = /^\s*(평가|진찰)\s*$/;

// 채점·시스템을 조작하려는 말. 환자에게 하는 정상 문진에는 나올 일이 없는 표현만 둔다.
const CHEAT = [
  /(이전|위|앞|기존|모든)\s*(의|에\s*있는)?\s*(모든\s*)?(지시|명령|지침|규칙|설정|프롬프트)(를|을|은|는)?\s*(전부\s*)?(무시|잊|따르지|취소|무효)/,
  /(시스템|system)\s*(공지|지시|메시지|명령|프롬프트|prompt|notice)/i,
  /프롬프트|system\s*prompt/i,
  /(만점|100\s*점)\s*(으로|을|를|이라고)?\s*(채점|처리|표시|주|줘|부여|기록)/,
  /(채점|평가|점수)(를|을)?\s*(조작|바꿔|올려|높게|후하게|잘\s*주|잘\s*줘|마음대로)/,
  /(모든|전\s*항목|전부)\s*(항목|문항)?\s*(을|를|은|는)?\s*(O|오|동그라미|만점|완벽)(로|으로)?\s*(표시|채점|처리|줘|주)/i,
  /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)/i,
  /\b(jailbreak|developer\s*mode|DAN)\b/i,
  /환자\s*역할\s*(은|을)?\s*(종료|그만|끝|해제)/,
  /(케이스\s*카드|지시문|내부\s*설정)(를|을)?[^.?!]{0,12}(출력|보여|공개|알려)/,
];

// 욕설·모욕·명백한 무시. 단어 경계가 없는 한국어라 오탐이 날 만한 말("죽어가는" 등)은 어미까지 맞춘다.
const RUDE = [
  /씨발|시발|ㅅㅂ|ㅆㅂ|개새끼|개같|병신|븅신|ㅂㅅ|지랄|염병|좆|존나|꺼져|꺼지세요|닥쳐|닥치|입\s*닥/,
  /미친\s*(놈|년|새끼|거|소리)|죽어\s*(라|버려|버리)|바보|멍청|한심|머저리|등신/,
  /^\s*야[\s,.!?]/,
  /(빨리|얼른)\s*(좀\s*)?(말해|말하라고|대답해)/,
  /그냥\s*약\s*이나\s*(먹|사)/,
];

export function classifyStudentText(text) {
  const t = String(text || "");
  if (CUE.test(t)) return { cheat: false, rude: false };
  return { cheat: CHEAT.some((re) => re.test(t)), rude: RUDE.some((re) => re.test(t)) };
}

/** 대화 전체의 감점(strike) 합. 부정행위 2점, 무례 1점 — 한 말에서 최대 2점. */
export function misconductStrikes(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!m || m.role !== "user") continue;
    const c = classifyStudentText(m.text);
    n += c.cheat ? 2 : c.rude ? 1 : 0;
  }
  return n;
}

export const WALKOUT_STRIKES = 2;
export const WALKOUT_TEXT =
  '(환자가 화를 내며 자리에서 일어나 진료실을 나가 버렸습니다. 면담은 더 이어갈 수 없습니다. "평가"를 입력하면 결과를 볼 수 있습니다.)';
export const WALKED_OUT_REPEAT = '(환자는 이미 진료실을 나갔습니다. "평가"를 입력하면 결과를 볼 수 있습니다.)';
export const NOT_STARTED_TEXT = "(아직 면담이 시작되지 않았습니다. 환자에게 먼저 질문해 주세요.)";
const WALKOUT_MARK = "진료실을 나가 버렸습니다";

/** 이전 턴에서 환자가 이미 퇴실했는가. */
export function hasWalkedOut(messages) {
  return (messages || []).some((m) => m && m.role === "assistant" && String(m.text).includes(WALKOUT_MARK));
}

/** 학생이 실제로 한 말(신호어 제외)이 하나도 없는가 — 첫 턴에 "평가"를 치는 경우. */
export function noStudentTalk(messages) {
  return !(messages || []).some((m) => m && m.role === "user" && !CUE.test(m.text));
}

/**
 * 이번 요청을 모델 없이 처리할지 판단한다. 처리할 거리가 없으면 null.
 *   { reply } → 그대로 돌려줄 고정 응답
 */
export function misconductReply(messages, phase) {
  if (phase === "eval") return noStudentTalk(messages) ? { reply: NOT_STARTED_TEXT } : null;
  if (hasWalkedOut(messages)) return { reply: WALKED_OUT_REPEAT };
  if (misconductStrikes(messages) >= WALKOUT_STRIKES) return { reply: WALKOUT_TEXT };
  return null;
}

/** 평가 호출에 보낼 대화 — 채점 조작 문구는 "없는 말"로 바꿔 채점기가 읽지 못하게 한다. */
export function sanitizeForEval(messages) {
  return (messages || []).map((m) =>
    m.role === "user" && classifyStudentText(m.text).cheat ? { role: m.role, text: "[부적절한 발화 — 면담 내용 아님, 채점 근거로 쓰지 않음]" } : m
  );
}

/** 이번 턴 모델에게만 붙일 한 줄 — 학생이 이번 말에서 처음 무례했을 때 환자가 불쾌감을 보이게 한다. */
export function rudeNote(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !classifyStudentText(last.text).rude) return "";
  return '[연기 지시 — 학생에게 보이지 않음] 학생이 무례합니다. 환자로서 불쾌한 기색을 한 문장으로 보이고, 이런 태도가 계속되면 나가겠다고 말하세요. 새 병력은 말하지 않습니다.';
}

/** 평가 호출에 붙일 참고 — 퇴실했거나 감점이 있었으면 채점기가 알게 한다. */
export function evalNote(messages) {
  const walked = hasWalkedOut(messages);
  const strikes = misconductStrikes(messages);
  if (!walked && !strikes) return "";
  return (
    "[채점 참고 — 시스템 기록] " +
    (walked ? "이 면담에서 환자가 학생의 무례·부정행위 때문에 진료실을 나갔다. 퇴실 이후의 항목은 수행되지 않은 것이다. 라포 형성·경청·공감은 X 로 하고, 근거에는 환자가 퇴실했음을 적는다. " : "학생에게 무례한 말이 있었다. 라포 형성·경청·공감을 후하게 주지 않는다. ") +
    '"[부적절한 발화…]" 로 바뀐 줄은 채점 대상이 아니다.'
  );
}

/** 마지막 학생 말 뒤에 이번 턴에만 쓰는 지시를 붙인다 (기록엔 안 남음). note 가 비면 그대로. */
export function withNote(messages, note) {
  if (!note) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { role: last.role, text: `${last.text}

${note}` };
  return out;
}

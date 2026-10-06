/**
 * "키 없이" 면담의 진찰 단계를 모델 없이 처리한다.
 *
 * 진찰 소견은 케이스를 뽑을 때 이미 확정돼 있어서(확률 소견까지) 모델이 할 일은 학생이 말한
 * 진찰 동작에 맞는 소견을 골라 읽어 주는 것뿐이다. 그런데 진찰 한 턴마다 시스템 프롬프트
 * (평균 5,400자)와 대화 전체를 다시 보내야 해서 진찰 단계가 면담 비용의 상당 부분을 먹었다.
 * 여기서 학생 말을 소견 이름에 맞춰 보고, 확실히 맞는 것만 바로 돌려준다. 애매하면 null —
 * 호출부가 지금처럼 모델에 넘긴다. 틀린 소견을 주는 것보다 모델에 넘기는 편이 낫다.
 *
 * 런타임 의존이 없어서 test/peMatch.test.mjs 가 그대로 import 한다.
 */

// 학생이 쓰는 말 → 소견 이름에 쓰인 말. 소견 이름 쪽 낱말로 모은다.
const SYNONYMS = [
  [/배|복부|아랫배|윗배|명치/, ["복부"]],
  [/심장|심음/, ["심음", "심장"]],
  [/폐|숨소리|호흡음/, ["폐음", "폐", "호흡음"]],
  [/갑상[선샘]/, ["갑상선", "갑상샘"]],
  [/목\s*(뒤|덜미)|뒷목/, ["경부", "목"]],
  [/목(?!구멍|\s*안)|경부/, ["경부", "목"]],
  [/다리|하지/, ["하지"]],
  [/종아리/, ["종아리", "하지"]],
  [/부었|부종|붓/, ["부종"]],
  [/결막|눈꺼풀\s*안|아래\s*눈꺼풀/, ["결막"]],
  [/공막|흰자/, ["공막"]],
  [/동공/, ["동공"]],
  [/입\s*안|입안|구강|혀/, ["구강"]],
  [/편도|목\s*안|인두|목구멍/, ["인두", "인후"]],
  [/림프절|멍울/, ["림프절"]],
  [/겨드랑이|액와/, ["액와", "겨드랑이"]],
  [/사타구니|서혜/, ["서혜부"]],
  [/쇄골/, ["쇄골상"]],
  [/옆구리|늑골척추각|CVA|등.*두드/i, ["늑골척추각"]],
  [/반발통|떼/, ["반발통"]],
  [/간\b|간을|간 /, ["간"]],
  [/비장/, ["비장"]],
  [/직장|항문/, ["직장", "항문"]],
  [/반사|건반사/, ["반사", "심부건반사"]],
  [/바빈스키/, ["바빈스키"]],
  [/근력|힘/, ["근력"]],
  [/감각/, ["감각"]],
  [/걸어|걸음|보행/, ["보행"]],
  [/피부/, ["피부"]],
  [/관절/, ["관절"]],
  [/경정맥/, ["경정맥"]],
  [/기립|일어서|일어나/, ["기립"]],
  [/귀|고막|이경/, ["이경검사", "고막"]],
  [/안저/, ["안저검사", "안저"]],
  [/유방|가슴\s*(덩이|멍울|촉진)/, ["유방"]],
  // 진찰 동작
  [/청진|들어\s*보|들어볼|소리/, ["청진"]],
  [/촉진|눌러|만져|눌러보/, ["촉진"]],
  [/타진|두드려|두드리/, ["타진"]],
  [/시진|살펴/, ["시진"]],
];
// "들어볼게요", "눌러 보겠습니다"의 "보겠/볼게"는 시진이 아니다 — 다른 동작 낱말이 없을 때만 시진으로 본다.
const WEAK_INSPECT = /볼게|봐도|보겠/;

// 소견 이름에서 떼어 볼 낱말 단위. "복부 촉진" → [복부, 촉진], "인지 — 지남력" → [인지, 지남력].
function keyTokens(key) {
  return key
    .replace(/\(.*?\)/g, " ")
    .split(/[\s·—\-,/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);
}

const ACTIONS = new Set(["청진", "촉진", "타진", "시진"]);
// 부위 전체를 한 칸에 적은 소견. 시진·촉진·청진 결과가 한꺼번에 들어 있어서, 학생이 한 동작만
// 했는데 다른 동작의 결과까지 드러난다. 이런 칸은 모델에 넘겨 해당 동작만 골라 말하게 한다.
const BROAD = new Set(["복부", "목", "하지", "피부", "손", "얼굴", "눈", "머리", "사지", "흉곽", "척추", "유방", "부종", "림프절", "관절", "흉부"]);

/**
 * 학생 말에서 낱말 묶음을 만든다. 묶음 하나는 학생이 한 말 하나(예: "폐", "목구멍")에 해당하는
 * 소견 이름 쪽 낱말들이다 — 같은 말이 인두/인후처럼 여러 이름으로 불리기 때문에 묶어 둔다.
 */
function conceptGroups(text) {
  const groups = SYNONYMS.filter(([re]) => re.test(text)).map(([, words]) => words);
  const acted = groups.some((g) => g.some((w) => ["청진", "촉진", "타진"].includes(w)));
  if (!acted && WEAK_INSPECT.test(text) && !groups.some((g) => g.includes("시진"))) groups.push(["시진"]);
  // 누르거나 두드려 보는 동작은 "…압통" 소견을 찾는 것이다("등 두드려 볼게요" → 늑골척추각 압통).
  if (groups.some((g) => g.includes("촉진") || g.includes("타진"))) groups.push(["압통"]);
  return groups;
}

/** 학생 말에서 소견 이름 쪽 낱말 집합을 만든다. */
function concepts(text) {
  return new Set(conceptGroups(text).flat());
}

/** 학생이 진찰 동작이 아니라 허락을 구하거나 설명하는 말이면 환자 반응이 필요하다 — 모델에 넘긴다. */
const ASKING = /(될까요|괜찮으|괜찮을|해도 되|하셔도|동의|설명|불편하시면|아프시면|\?)\s*\)?\s*$/;

/**
 * 학생 말에 맞는 소견을 찾는다. 확실할 때만 [{key, text}] 를, 아니면 null 을 돌려준다.
 *   - 소견 이름이 학생 말에 그대로 있으면(예: "Murphy 징후", "늑골척추각 압통") 그것.
 *   - 소견 이름의 부위 낱말이 맞고, 동작 낱말이 있으면 그것도 맞는 소견 전부.
 *     한 문장에 부위를 여럿 말하면("목구멍 시진하고 폐 청진") 각각의 소견을 모두 돌려준다.
 *   - 맞는 것이 너무 많으면(4개 이상) 무엇을 했는지 애매하다 — null.
 *   - 학생이 말한 부위 중 하나라도 맞는 소견이 없으면 null — 일부만 답하면 나머지 진찰이
 *     조용히 사라진다. 소견에 없는 진찰은 모델이 "특이소견 없음"으로 답한다.
 */
export function matchFindings(text, findings) {
  if (!text || !findings || ASKING.test(text.trim())) return null;
  const keys = Object.keys(findings);
  const matched = new Set();
  const direct = keys.filter((k) => {
    const base = k.replace(/\(.*?\)/g, "").trim();
    return base.length >= 3 && !BROAD.has(base) && text.includes(base);
  });
  if (direct.length && direct.length <= 3) direct.forEach((k) => matched.add(k));

  const groups = conceptGroups(text);
  const have = new Set(groups.flat());
  for (const key of keys) {
    const toks = keyTokens(key);
    const parts = toks.filter((t) => !ACTIONS.has(t));
    const acts = toks.filter((t) => ACTIONS.has(t));
    if (!parts.length || (BROAD.has(key) && !acts.length)) continue;
    // 부위 낱말은 전부 맞아야 한다("간 촉진"에 "복부를 눌러"가 걸리지 않게).
    if (!parts.every((t) => have.has(t))) continue;
    // 동작 낱말이 있으면 학생이 한 동작과 같아야 한다("복부 청진" ≠ "배를 눌러").
    if (acts.length && !acts.some((t) => have.has(t))) continue;
    matched.add(key);
  }
  if (!matched.size || matched.size > 4) return null;

  // 학생이 말한 부위마다 맞춘 소견이 하나는 있어야 한다.
  const covered = new Set([...matched].flatMap(keyTokens));
  const isAction = (g) => g.every((w) => ACTIONS.has(w) || w === "압통");
  const missed = groups.filter((g) => !isAction(g) && !g.some((w) => covered.has(w)));
  if (missed.length) return null;
  return [...matched].map((key) => ({ key, text: findings[key] }));
}

/** "진찰" 신호 직후 응답 — 활력징후만 괄호로 (프롬프트 "신체진찰 모드" 규칙과 같다). */
export function vitalsReply(vitals) {
  if (!vitals || !("sbp" in vitals)) return null;
  return `(혈압 ${vitals.sbp}/${vitals.dbp} mmHg, 맥박 ${vitals.hr}회/분, 호흡 ${vitals.rr}회/분, 체온 ${vitals.temp}℃, 산소포화도 ${vitals.spo2}%)`;
}

// 카드 작성자가 소견 값 끝에 괄호로 적어 둔 메모("…(수치는 뽑은 활력징후에 맞춘다)", "…(값은 슬롯에서)").
// 모델이 문장을 다시 쓸 때는 가려졌지만, 서버가 값을 그대로 읽어 주면 학생에게 그대로 보인다.
const AUTHOR_NOTE = /\s*\([^()]*(?:맞춘다|맞춰|뽑은|슬롯|채운다|채워|작성자|모델이|프롬프트)[^()]*\)/g;

/** 맞춘 소견을 서술자 톤으로 붙인다. 양팔 혈압 차이처럼 활력징후 값을 가리키는 소견은 숫자를 채운다. */
export function findingsReply(matches, vitals) {
  return matches
    .map(({ key, text }) => {
      let t = String(text);
      if (vitals && "armDiff" in vitals && /양팔 수축기압 차이/.test(t)) t = t.replace(/\(차이는[^)]*\)/, `(차이 ${vitals.armDiff} mmHg)`);
      t = t.replace(AUTHOR_NOTE, "").trim();
      return `(${key}: ${t})`;
    })
    .join("\n");
}

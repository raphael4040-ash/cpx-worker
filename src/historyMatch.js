/**
 * 문진의 정형 질문(이름·나이 확인, 직업, 술, 담배, 약 알레르기)을 모델 없이 답한다.
 *
 * 이 값들은 케이스를 뽑을 때 정해지고(personas.json 의 정해진 몇 가지 중 하나), 학생은 거의 모든 면담에서
 * 같은 말로 묻는다. 모델 한 턴은 시스템 프롬프트와 대화 전체(평균 입력 4,000토큰)를 다시 보내야 해서,
 * 이런 턴을 서버가 답하면 하루 무료 한도로 할 수 있는 면담 수가 늘어난다 (2026-11-22).
 *
 * 원칙은 peMatch.js 와 같다 — 확실할 때만 답하고, 애매하면 null 을 돌려 모델에 넘긴다.
 *   - 보호자가 대신 답하는 케이스, 미성년, 사회력에 방어적이거나 짜증이 묻어나야 하는 성격(의심형·축소형·죄책감형·짜증형)의 술·담배는 넘긴다.
 *   - 술·담배가 주제이거나(물질·음주·금연 상담) 카드가 따로 적은 흡연·음주(id "card"), 사회력·Red flag 에
 *     덧붙인 술·담배 이야기가 있으면 그 항목은 넘긴다 — 정해 둔 문장으로는 그 내용이 빠진다.
 *   - 질문에 다른 내용(증상, 기간, 가족, 생년월일 …)이 섞이면 넘긴다.
 *
 * 런타임 의존이 없어서 test/historyMatch.test.mjs 가 그대로 import 한다.
 */

const SMOKE_SAY = {
  never: "담배는 안 피워요.",
  ex: "예전엔 피웠는데, 끊은 지 몇 년 됐어요.",
  occasional: "하루에 반 갑 정도 피워요.",
  light: "하루에 반 갑씩 피워요. 10년쯤 됐어요.",
  heavy: "하루에 한 갑 넘게 피워요. 20년도 넘었어요.",
};
const ALCOHOL_SAY = {
  none: "술은 안 마셔요.",
  social: "일주일에 한 번 정도, 소주 반 병쯤 마셔요.",
  heavy: "일주일에 서너 번 마시고, 한 번에 소주 한 병 넘게 마셔요.",
};
const JOB_SAY = {
  "사무직 회사원": "회사 다녀요. 사무직이에요.",
  "중학교 교사": "중학교 교사예요.",
  농사: "농사 지어요.",
  "건설 현장 일용직": "건설 현장에서 일용직으로 일해요.",
  "택시 기사": "택시 운전해요.",
  "시장 상인": "시장에서 장사해요.",
  주부: "주부예요.",
  "은퇴 후 무직": "은퇴하고 지금은 일 안 해요.",
  대학생: "대학생이에요.",
  간호사: "간호사예요.",
  "식당 주방": "식당 주방에서 일해요.",
  "배달 라이더": "배달 일 해요.",
  용접공: "용접 일 해요.",
  요양보호사: "요양보호사로 일해요.",
  "군인(부사관)": "부사관으로 군 복무하고 있어요.",
  "자영업(카페)": "카페를 하고 있어요.",
  고등학생: "고등학생이에요.",
  무직: "지금은 일을 안 해요.",
  아르바이트: "아르바이트하고 있어요.",
  중학생: "중학생이에요.",
  초등학생: "초등학생이에요.",
};

// 사회력 질문에 방어적이거나 줄여 말하는 성격, 말투에 짜증이 묻어나야 하는 성격 — 그 태도가 답에 드러나야 하므로
// 술·담배는 모델에 넘긴다 (짜증형은 2026-11-22 실제 면담에서 서버 답이 너무 담담했다).
const GUARDED = new Set(["suspicious", "minimizer", "guilty", "irritable"]);
// 술·담배가 면담의 중심인 주제 (물질오남용, 음주 상담, 금연 상담).
const HABIT_TOPICS = /^(17|35-1|35-2)-/;
const ADULT_AGE = 19;

const SMOKE_WORDS = /담배|흡연|금연|니코틴|궐련|전자담배/;
const ALCOHOL_WORDS = /술|음주|소주|맥주|막걸리|와인|알코올|알콜/;
const ALLERGY_WORDS = /알레르기|알러지|아토피|천식|두드러기|비염/;

function qaText(obj) {
  if (!obj || typeof obj !== "object") return "";
  return Object.entries(obj)
    .map(([q, a]) => `${q} ${typeof a === "string" ? a : ""}`)
    .join("\n");
}

/**
 * 케이스에서 서버가 답해도 되는 값만 골라 둔다. 세션에 저장한다.
 *   kase     — sampleCase.buildCase 결과 (person 에 personas 의 id 가 있다)
 *   resolved — caseToPrompt 결과 (채워진 시나리오·사회력)
 *   fileKey  — "21-abdominal-pain" 같은 카드 파일 이름
 */
export function historyFacts(kase, resolved, fileKey = "") {
  const p = kase && kase.person;
  if (!p || p.guardian) return null; // 보호자가 함께 오면 누가 답할지부터 모델이 정한다
  const s = (resolved && resolved.scenario) || {};
  const person = (resolved && resolved.person) || {};
  const facts = { name: p.name, age: p.age };

  facts.job = JOB_SAY[p.occupation && p.occupation.label] ? p.occupation.label : null;

  // 술·담배 — 정해진 몇 가지 중 하나이고, 카드가 그 밖의 이야기를 덧붙이지 않았을 때만.
  const habitsOk =
    p.age >= ADULT_AGE &&
    !GUARDED.has(p.personality && p.personality.id) &&
    !HABIT_TOPICS.test(fileKey) &&
    !s.coverStory &&
    !s.stage;
  const shCard = String(person.shResolved || s.sh || "").replace(/^직업[^·.]*(·\s*흡연[^·]*·\s*음주[^.]*)?\.?\s*/, "");
  const extra = [shCard, qaText(s.redFlags), qaText(s.dietActivity), qaText(s.safetyAssessment), (s.disclosure ? JSON.stringify(s.disclosure) : "")].join("\n");
  const smokeId = p.smoking && p.smoking.id;
  const alcoholId = p.alcohol && p.alcohol.id;
  facts.smoke = habitsOk && SMOKE_SAY[smokeId] && !SMOKE_WORDS.test(extra) ? smokeId : null;
  facts.alcohol = habitsOk && ALCOHOL_SAY[alcoholId] && !ALCOHOL_WORDS.test(extra) ? alcoholId : null;

  // 약 알레르기 — 없을 때만. 알레르기·아토피·천식 이야기가 카드 어디에든 있으면 넘긴다(알레르기 비염 케이스 등).
  const allergy = String(s.allergy || "").trim();
  const cardText = [resolved && resolved.dx, s.pmh, s.fh, s.meds, qaText(s.redFlags), s.assoc ? JSON.stringify(s.assoc) : "", qaText(s.hpi)].join("\n");
  facts.allergyNone = (!allergy || /^없음\.?$/.test(allergy)) && !ALLERGY_WORDS.test(cardText);
  return facts;
}

// 질문이 이 정형 항목만 묻는지 가르는 낱말들.
const ASK = {
  name: /성함|이름/,
  age: /나이|연세|몇\s*살/,
  job: /직업|하시는\s*일|무슨\s*일\s*(?:을\s*)?하|어떤\s*일\s*(?:을\s*)?하|일은\s*(?:뭐|어떤|무슨)/,
  alcohol: /술|음주/,
  smoke: /담배|흡연/,
  allergy: /알레르기|알러지/,
};
// 이런 말이 섞이면 정형 질문이 아니다 — 모델에 넘긴다.
//   "술 마시면 더 아파요?"(악화 요인), "가족 중에 술"(가족력), "언제부터 피우셨어요?"(기간), "생년월일"(월·일은 모델이 정한다),
//   "무슨 일로 오셨어요?"(내원 이유), "끊으실 생각"(상담) 등.
const OTHER =
  /아프|아파|통증|증상|불편|오셨|오신|심해|좋아지|나빠|때문|마시면|드시면|피우면|마신\s*(?:뒤|후|다음)|후에|뒤에|가족|아버지|어머니|아빠|엄마|남편|아내|부모|형제|자녀|끊|줄이|줄일|금연|절주|생각|계획|오래|몇\s*년|언제|처음|생년|생일|태어|드시는\s*약|복용|병|수술|입원|월경|생리|임신|체중|열|땀|운동|식사|잠|스트레스|여행|성생활|접종|주사|음식|커피|카페인/;

function hasBatchim(word) {
  const c = String(word).trim().slice(-1).charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
}

/** 학생 말이 정형 질문뿐이면 환자 답을, 아니면 null. facts 는 historyFacts 결과(세션에 저장된 것). */
export function historyReply(text, facts) {
  if (!facts || !text) return null;
  let t = String(text).trim();
  if (t.length > 90) return null;
  // "약 알레르기"의 "약"은 복용약 질문이 아니다.
  const probe = t.replace(/약\s*알레르기|약\s*알러지/g, "알레르기");
  const asked = Object.keys(ASK).filter((k) => ASK[k].test(probe));
  if (!asked.length) return null;
  // 직업 질문의 "일"과 겹치는 내원 이유("무슨 일로 오셨어요") 등은 OTHER 가 막는다.
  if (OTHER.test(probe)) return null;
  // "약 이름 아세요?"의 "이름"은 환자 이름이 아니다 (2026-11-24 Gemma 점검에서 "손영희예요."로 답했다).
  if (/(약|약물|병|병원|검사|진단|회사|학교|동네|아이|애)\s*(?:의\s*)?이름|이름이\s*(?:뭐였|기억)/.test(probe)) return null;

  const parts = [];
  const nameQ = asked.includes("name"), ageQ = asked.includes("age");
  if (nameQ || ageQ) {
    if (!facts.name || !Number.isFinite(facts.age)) return null;
    const n = facts.name;
    // 받침이 없어도 "고학수고요"보다 "고학수이고요"가 이름을 댈 때 자연스럽다.
    if (nameQ && ageQ) parts.push(`${n}이고요, ${facts.age}살이에요.`);
    else if (nameQ) parts.push(`${n}${hasBatchim(n) ? "이에요" : "예요"}.`);
    else parts.push(`${facts.age}살이에요.`);
  }
  if (asked.includes("job")) {
    if (!facts.job || !JOB_SAY[facts.job]) return null;
    parts.push(JOB_SAY[facts.job]);
  }
  const alc = asked.includes("alcohol"), smk = asked.includes("smoke");
  if ((alc && !facts.alcohol) || (smk && !facts.smoke)) return null;
  if (alc && smk && facts.alcohol === "none" && facts.smoke === "never") parts.push("술도 안 마시고 담배도 안 피워요.");
  else {
    if (alc) parts.push(ALCOHOL_SAY[facts.alcohol]);
    // 술과 함께 물으면 담배 문장에 주어를 붙인다 ("…마셔요. 담배는 하루에 반 갑씩 피워요.").
    if (smk) parts.push(alc && !/^담배/.test(SMOKE_SAY[facts.smoke]) ? "담배는 " + SMOKE_SAY[facts.smoke] : SMOKE_SAY[facts.smoke]);
  }
  if (asked.includes("allergy")) {
    if (!facts.allergyNone) return null;
    parts.push("알레르기는 없어요.");
  }
  // 하나만 물었고 "없다"는 답이면 "아뇨,"로 받는다 ("담배 피우세요?" → "아뇨, 담배는 안 피워요.").
  const single = asked.length === 1 || (nameQ && ageQ && asked.length === 2);
  const negative = /안 마셔요|안 피워요|없어요/.test(parts[0] || "");
  let reply = parts.join(" ");
  if (single && negative && !/얼마나|어떻게|어느 정도/.test(probe)) reply = "아뇨, " + reply;
  // 인사와 함께 신원 확인을 하면 인사부터 받는다.
  if (/안녕/.test(probe) && (nameQ || ageQ)) reply = "안녕하세요. " + reply;
  return reply;
}

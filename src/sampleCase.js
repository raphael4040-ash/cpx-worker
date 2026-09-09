/**
 * cpx-plugin/cpx/tools/sample_case.py 의 JS 포팅.
 *
 * 카드(진단 시나리오) + personas.json(인물) + variations(표현 변주)를 조합해
 * 한 세션 분량의 완성된 환자 설정을 만든다. 로직은 파이썬 원본과 최대한 1:1로
 * 맞춘다 — 원본이 수많은 실제 버그를 겪고 고친 결과물이라, 여기서 "더 낫게"
 * 고치려 하면 그 버그들이 되살아난다. 원본에 있던 주석도 그대로 옮긴다.
 *
 * 파이썬 쪽을 고치면 이 파일도 같이 고쳐야 한다 (자동 동기화 없음).
 */

const MAX_RETRY = 20;
const SMOKING_START_AGE = 19;
const ADULT_AGE = 19;

const NONE_PMH_RE =
  /^(특이 병력 없음|특이사항 없음|특별한 병력? 없음|특별한 병은 없어요|큰 병력 없음|병력 없음|특이사항 없어요|없음)$/;

const NONE_MEDS_RE =
  /^(복용\s*중인\s*|복용\s*|따로\s*|그\s*밖에\s*|새로\s*먹기\s*시작한\s*|챙겨\s*|먹는\s*|드시는\s*)*약(은|이)?\s*(따로\s*)?(없(음|어요|습니다|다)|안\s*먹(어요|습니다|음|는다))\.?$|^(복용\s*약\s*)?없(음|어요|습니다)\.?$/;

// ---------------------------------------------------------------- 추첨 보조

function randint(lo, hi) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function uniform(lo, hi) {
  return Math.random() * (hi - lo) + lo;
}

function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sample(arr, k) {
  const pool = arr.slice();
  const out = [];
  for (let i = 0; i < k && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** weight 필드를 존중해 하나 고른다. weight 가 없으면 1로 본다. */
function weighted(pool) {
  const bag = [];
  for (const item of pool) {
    const w = Math.max(1, parseInt(item.weight ?? 1, 10));
    for (let i = 0; i < w; i++) bag.push(item);
  }
  return choice(bag);
}

/** '하루 한 갑 이상, 20년 이상' -> 20. 숫자가 없으면 0. */
function yearsIn(label) {
  const m = [...(label || "").matchAll(/(\d+)\s*년/g)].map((x) => parseInt(x[1], 10));
  return m.length ? Math.max(...m) : 0;
}

function ageOk(item, age) {
  return age >= parseInt(item.minAge ?? 0, 10);
}

function occupationOk(occ, age) {
  const [lo, hi] = occ.ageRange || [0, 200];
  return lo <= age && age <= hi;
}

// ---------------------------------------------------------------- 검증

/** _incompatible 을 "종류:id|종류:id" 키 집합으로 바꾼다 (순서 무관하게 비교). */
function incompatiblePairs(personas) {
  return (personas._incompatible || []).map((r) => [r.a, r.b]);
}

function personTokens(p) {
  return new Set([
    "personality:" + p.personality.id,
    "healthLiteracy:" + p.healthLiteracy.id,
    "ice:" + p.ice.id,
    "occupation:" + p.occupation.id,
  ]);
}

function hasIncompatible(pairs, toks) {
  return pairs.some(([a, b]) => toks.has(a) && toks.has(b));
}

// 카드 작성자가 모델에게 남긴 지시문. 학생이 읽으면 안 된다.
const DIRECTIVE_PREFIXES = [/^인물 카드를 따르되[,]?\s*/, /^인물 카드를 따름[.,]?\s*/];
const DIRECTIVE_MARKS = [
  "인물 카드", "덮어쓴다", "그대로 쓴다", "변주를 쓴다", "변주는",
  "확인이 중요", "로 읽는다", "항목을 따르", "필수", "반드시",
  "이상 보유",
];

function stripDirectives(text) {
  if (!text) return "";
  for (const pat of DIRECTIVE_PREFIXES) text = text.replace(pat, "");
  const kept = text
    .split(/(?<=\.)\s+/)
    .filter((s) => s.trim() && !DIRECTIVE_MARKS.some((m) => s.includes(m)));
  return kept.join(" ").trim();
}

const RISK_ALIAS = {
  smoking: "흡연", "smoking:heavy": "흡연:heavy", alcohol: "음주",
  htn: "고혈압", dm: "당뇨병", dyslip: "이상지질혈증",
  thyroid: "갑상선기능저하증", gout: "통풍", depress: "우울증",
};

function validate(person, scenario, personas, problems) {
  const age = person.age;

  if (!occupationOk(person.occupation, age)) {
    problems.push(`직업-나이: ${person.occupation.label} / ${age}세`);
  }

  for (const key of ["smoking", "alcohol", "illness"]) {
    const item = person[key];
    if (!ageOk(item, age)) {
      problems.push(`${key}-나이: ${item.label} / ${age}세 (minAge ${item.minAge})`);
    }
  }

  const yrs = yearsIn(person.smoking.label);
  if (yrs && yrs > age - SMOKING_START_AGE) {
    problems.push(`흡연기간: ${yrs}년 / ${age}세`);
  }

  const toks = personTokens(person);
  for (const [a, b] of incompatiblePairs(personas)) {
    if (toks.has(a) && toks.has(b)) problems.push(`상충 조합: ${[a, b].sort().join(" + ")}`);
  }

  const sex = person.sex;
  for (const [slot, val] of Object.entries(person.slots || {})) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (val.sexOnly && val.sexOnly !== sex) {
        problems.push(`성별 제한 변주: ${slot} (${val.sexOnly} 전용인데 ${sex})`);
      }
      if (val.maxAge != null && age > val.maxAge) {
        problems.push(`연령 제한 변주: ${slot} (최대 ${val.maxAge}세인데 ${age}세)`);
      }
      if (val.minAge != null && age < val.minAge) {
        problems.push(`연령 제한 변주: ${slot} (최소 ${val.minAge}세인데 ${age}세)`);
      }
    }
  }

  const c = scenario.constraints;
  const [lo, hi] = c.ageRange;
  if (!(lo <= age && age <= hi)) problems.push(`시나리오 연령 범위 밖: ${age}세 (${lo}~${hi})`);
  if ((c.sex || "any") !== "any" && c.sex !== sex) problems.push("시나리오 성별 불일치");

  const banned = new Set(c.forbidden || []);
  const ill = person.illness;
  if (banned.has(ill.id) || banned.has(ill.label)) problems.push(`카드가 금지한 지병: ${ill.label}`);

  for (const r of person.forcedRisk_raw || []) {
    const want = RISK_ALIAS[r] || r;
    let ok;
    if (want === "음주" || want === "과음") {
      ok = want === "과음"
        ? ["heavy", "card"].includes(person.alcohol.id)
        : ["social", "heavy", "card"].includes(person.alcohol.id);
    } else if (want === "흡연" || want === "흡연:heavy") {
      ok = want.endsWith("heavy")
        ? ["light", "heavy", "card"].includes(person.smoking.id)
        : ["light", "heavy", "ex", "occasional", "card"].includes(person.smoking.id);
    } else {
      ok = person.illness.label === want || person.illness.id === want;
    }
    if (!ok) problems.push(`요구한 위험인자 미적용: ${r}`);
  }

  for (const key of ["smoking", "alcohol"]) {
    const want = c[key];
    if (want && !c[key + "Label"]) {
      if (!(HABIT_IDS[key][want] || []).includes(person[key].id)) {
        problems.push(`카드가 요구한 ${key}(${want}) 미적용: ${person[key].label}`);
      }
    }
  }

  const v = (scenario.pe || {}).vitals;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of ["sbp", "dbp", "hr", "rr", "temp", "spo2"]) {
      if (!(k in v)) problems.push(`활력징후 밴드 누락: ${k}`);
    }
    if (!("invariant" in v)) problems.push("활력징후 invariant 누락");
  } else if (scenario.pe) {
    problems.push("활력징후 형식: 밴드가 아님");
  }

  for (const [key, val] of Object.entries((scenario.pe || {}).findings || {})) {
    if (val && typeof val === "object") {
      const p = parseFloat(val.p ?? 0);
      if (!(p > 0 && p < 1)) problems.push(`확률 소견 p 범위: ${key}`);
      for (const need of ["detected", "notDetected"]) {
        if (!val[need]) problems.push(`확률 소견 ${need} 누락: ${key}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 인물 추첨

const HABIT_IDS = {
  smoking: {
    current: ["occasional", "light", "heavy"],
    ever: ["occasional", "light", "heavy", "ex"],
    heavy: ["light", "heavy"],
    notCurrent: ["never", "ex"],
    never: ["never"],
  },
  alcohol: {
    drinker: ["social", "heavy"],
    heavy: ["heavy"],
    notHeavy: ["none", "social"],
    never: ["none"],
  },
};

function forceHabit(person, key, want, label, personas, age) {
  if (label) {
    person[key] = { id: "card", label, minAge: 0 };
    return;
  }
  const ids = HABIT_IDS[key][want || ""];
  if (!ids) return;
  let pool = personas[key].filter((x) => ids.includes(x.id) && ageOk(x, age));
  if (key === "smoking") {
    pool = pool.filter((x) => yearsIn(x.label) <= age - SMOKING_START_AGE);
  }
  if (pool.length) person[key] = weighted(pool);
}

function drawPerson(scenario, personas) {
  const c = scenario.constraints;
  const [lo, hi] = c.ageRange;
  const age = randint(lo, hi);

  let sex = c.sex || "any";
  if (sex === "any") sex = choice(["male", "female"]);

  const surname = choice(personas.surnames);
  const namePool = personas.givenNames[sex === "male" ? "male" : "female"];
  let given;
  if (!Array.isArray(namePool)) {
    const band = age <= 25 ? "young" : age <= 55 ? "mid" : "old";
    given = choice(namePool[band]);
  } else {
    given = choice(namePool);
  }

  function bySex(pool) {
    const bag = [];
    for (const o of pool) {
      const w = Math.max(1, parseInt((o.sexWeight || {})[sex] ?? 1, 10));
      for (let i = 0; i < w; i++) bag.push(o);
    }
    return bag.length ? choice(bag) : null;
  }

  const bias = personas.occupations.filter(
    (o) => (scenario.occupationBias || []).includes(o.id) && occupationOk(o, age)
  );
  let allowed_ = personas.occupations.filter((o) => occupationOk(o, age));
  if (!allowed_.length) {
    const distance = (o) => {
      const [lo2, hi2] = o.ageRange || [0, 200];
      return age < lo2 ? lo2 - age : age - hi2;
    };
    allowed_ = personas.occupations.slice().sort((a, b) => distance(a) - distance(b)).slice(0, 3);
  }
  const occupation = bias.length && Math.random() < 0.6 ? bySex(bias) : bySex(allowed_);

  const personality = choice(personas.personalities);
  const literacy = weighted(personas.healthLiteracy);

  const hints = scenario.iceHint || [];
  const icePool = personas.iceStyles.filter((i) => hints.includes(i.id));
  const iceCandidates = icePool.length ? icePool : personas.iceStyles;
  let ice = choice(iceCandidates);

  function pickAged(key) {
    const pool = personas[key].filter((x) => ageOk(x, age));
    return weighted(pool.length ? pool : [personas[key][0]]);
  }

  const banned = new Set(c.forbidden || []);
  const illPool = personas.backgroundIllness.filter(
    (x) => ageOk(x, age) && !banned.has(x.id) && !banned.has(x.label)
  );
  let illness = illPool.length ? weighted(illPool) : pickAged("backgroundIllness");
  let smoking = pickAged("smoking");
  let alcohol = pickAged("alcohol");

  let tries = 0;
  while (yearsIn(smoking.label) > age - SMOKING_START_AGE && tries < MAX_RETRY) {
    smoking = pickAged("smoking");
    tries++;
  }

  const person = {
    name: surname + given, age, sex,
    occupation, personality, healthLiteracy: literacy, ice,
    illness, smoking, alcohol,
  };

  const pairs = incompatiblePairs(personas);
  tries = 0;
  while (tries < MAX_RETRY) {
    const toks = personTokens(person);
    if (!hasIncompatible(pairs, toks)) break;
    person.ice = choice(iceCandidates);
    person.healthLiteracy = weighted(personas.healthLiteracy);
    person.personality = choice(personas.personalities);
    tries++;
  }

  const required = c.requiredRisk || [];
  const need = parseInt(c.requiredRiskMin ?? 0, 10);
  let forced = [];
  if (required.length && need) {
    const habit = required.filter((r) =>
      ["흡연", "흡연:heavy", "음주", "과음"].includes(RISK_ALIAS[r] || r)
    );
    const illnessReq = required.filter((r) => !habit.includes(r));
    const pool = [...habit, ...(illnessReq.length ? ["__illness__"] : [])];
    const picked = sample(pool, Math.min(need, pool.length));
    forced = picked.filter((r) => r !== "__illness__");
    if (picked.includes("__illness__")) forced.push(choice(illnessReq));

    for (const r of forced) {
      const want = RISK_ALIAS[r] || r;
      if (want === "흡연" || want === "흡연:heavy") {
        const ids = want.endsWith("heavy") ? ["light", "heavy"] : ["occasional", "light", "heavy", "ex"];
        const pool2 = personas.smoking.filter(
          (s) => ids.includes(s.id) && ageOk(s, age) && yearsIn(s.label) <= age - SMOKING_START_AGE
        );
        if (pool2.length) person.smoking = choice(pool2);
      } else if (want === "음주" || want === "과음") {
        const ids = want === "과음" ? ["heavy"] : ["social", "heavy"];
        const pool2 = personas.alcohol.filter((a) => ids.includes(a.id) && ageOk(a, age));
        if (pool2.length) person.alcohol = choice(pool2);
      } else {
        const match = personas.backgroundIllness.filter(
          (b) => (b.label === want || b.id === want) && ageOk(b, age)
        );
        if (match.length) person.illness = match[0];
      }
    }
  }
  person.forcedRisk_raw = forced;
  person.forcedRisk = forced.map((r) => RISK_ALIAS[r] || r);

  forceHabit(person, "smoking", c.smoking, c.smokingLabel, personas, age);
  forceHabit(person, "alcohol", c.alcohol, c.alcoholLabel, personas, age);

  return person;
}

function drawGuardian(scenario, person, personas, slots) {
  const info = fillDeep(scenario.informant, slots);
  if (!info) return null;
  const age = person.age;
  const rel = typeof info === "object" ? String(info.relation || "") : String(info);

  const YOUNGER = ["딸", "아들", "자녀", "며느리", "사위", "손자", "손녀", "조카"];
  const OLDER = ["어머니", "아버지", "엄마", "아빠", "부모", "할머니", "할아버지"];
  const SAME = ["배우자", "남편", "아내", "형", "누나", "언니", "오빠", "동생", "친구", "이웃", "동료"];

  let kind;
  if (SAME.some((w) => rel.includes(w))) kind = "same";
  else if (YOUNGER.some((w) => rel.includes(w))) kind = "younger";
  else if (OLDER.some((w) => rel.includes(w))) kind = "older";
  else kind = age >= 60 ? "younger" : age <= 17 ? "older" : "same";

  let lo, hi, gSex;
  if (kind === "younger") {
    [lo, hi] = [age - 40, age - 22];
    gSex = Math.random() < 0.6 ? "female" : "male";
  } else if (kind === "same") {
    [lo, hi] = [age - 8, age + 8];
    gSex = Math.random() < 0.5 ? "male" : "female";
  } else {
    [lo, hi] = [age + 22, age + 40];
    gSex = Math.random() < 0.7 ? "female" : "male";
  }

  const FEMALE_REL = ["딸", "며느리", "어머니", "엄마", "아내", "누나", "언니", "할머니", "이모", "고모"];
  const MALE_REL = ["아들", "사위", "아버지", "아빠", "남편", "형", "오빠", "할아버지", "삼촌"];
  if (FEMALE_REL.some((w) => rel.includes(w))) gSex = "female";
  else if (MALE_REL.some((w) => rel.includes(w))) gSex = "male";

  lo = Math.max(lo, 22);
  hi = Math.min(hi, 88);
  if (lo > hi) lo = hi = Math.max(22, Math.min(88, hi));
  const gAge = randint(lo, hi);

  const gOcc = personas.occupations.filter((o) => occupationOk(o, gAge));
  const bag = [];
  for (const o of gOcc) {
    const w = Math.max(1, parseInt((o.sexWeight || {})[gSex] ?? 1, 10));
    for (let i = 0; i < w; i++) bag.push(o);
  }

  const gPerson = choice(personas.personalities);
  const gLit = weighted(personas.healthLiteracy);

  const out = {
    age: gAge, sex: gSex,
    occupation: bag.length ? choice(bag) : null,
    personality: gPerson, healthLiteracy: gLit, role: info,
  };
  if (typeof info === "object" && (info.voice || info.style)) out.voiceWins = true;
  return out;
}

// ---------------------------------------------------------------- 변주·활력징후

const OCC_GROUPS = {
  학생: ["student", "highschool", "middleschool", "elementary"],
  사무실: ["office", "teacher", "nurse", "selfemp"],
  현장: ["farmer", "construct", "market", "welder", "cook", "delivery", "driver", "care", "soldier"],
  집: ["housewife", "retired", "jobless"],
};

function allowedVal(v, person) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return true;
  if (v.sexOnly && v.sexOnly !== person.sex) return false;
  const want = v.occOnly;
  if (want) {
    const ids = new Set();
    for (const w of Array.isArray(want) ? want : [want]) {
      for (const id of OCC_GROUPS[w] || [w]) ids.add(id);
    }
    if (!ids.has(person.occupation.id)) return false;
  }
  if (v.maxAge != null && person.age > v.maxAge) return false;
  if (v.minAge != null && person.age < v.minAge) return false;
  return true;
}

function drawSlots(scenario, person) {
  const slots = {};
  for (const [key, pool] of Object.entries(scenario.variations || {})) {
    let candidates = pool.filter((v) => allowedVal(v, person));
    if (!candidates.length) {
      candidates = pool.filter((x) => !(x && typeof x === "object" && !Array.isArray(x)));
      if (!candidates.length) candidates = [""];
    }
    slots[key] = choice(candidates);
  }

  const alcoholLabel = person.alcohol.label;
  const smokingId = person.smoking.id;
  const auto = {
    smoking: person.smoking.label,
    alcohol: alcoholLabel,
    olderBro: person.sex === "male" ? "형" : "오빠",
    olderSis: person.sex === "male" ? "누나" : "언니",
    spouse: person.sex === "male" ? "아내" : "남편",
    inlaws: person.sex === "male" ? "처가" : "시댁",
    alcoholSay: alcoholLabel === "안 마심" ? "술은 안 마셔요." :
      `술은 ${alcoholLabel}${alcoholLabel.endsWith("이상") ? "" : " 정도"} 마셔요.`,
    alcoholSayHon: alcoholLabel === "안 마심" ? "술은 안 드세요." :
      `술은 ${alcoholLabel}${alcoholLabel.endsWith("이상") ? "" : " 정도"} 드세요.`,
    smokingSay: smokingId === "never" ? "담배는 안 피워요." :
      smokingId === "ex" ? "예전엔 피웠는데 끊었어요." : `담배는 ${person.smoking.label} 피워요.`,
  };
  for (const [k, v] of Object.entries(auto)) {
    if (!(k in slots)) slots[k] = v;
  }

  const pools = scenario.variations || {};
  for (const group of scenario.pairedVariations || []) {
    const keys = group.filter((k) => k in pools);
    if (keys.length < 2) continue;
    const minLen = Math.min(...keys.map((k) => pools[k].length));
    const usable = [];
    for (let i = 0; i < minLen; i++) {
      if (keys.every((k) => allowedVal(pools[k][i], person))) usable.push(i);
    }
    if (!usable.length) continue;
    const idx = choice(usable);
    for (const k of keys) slots[k] = pools[k][idx];
  }
  return slots;
}

function drawVitals(scenario, person, slots) {
  const v = (scenario.pe || {}).vitals;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { _raw: v ?? null };

  function band(key, step = 1) {
    const [lo, hi] = v[key];
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      return Math.round(uniform(lo, hi) * 10) / 10;
    }
    const val = randint(lo, hi);
    return val - (val % step);
  }

  let sbp = band("sbp", 2);
  let bonus = 0;
  if (person.illness.label === "고혈압") bonus += randint(5, 15);
  if (person.age >= 70) bonus += randint(0, 10);
  sbp = Math.min(sbp + bonus, v.sbp[1]);
  sbp -= sbp % 2;

  const out = {
    sbp, dbp: band("dbp", 2), hr: band("hr"),
    rr: band("rr"), temp: band("temp"), spo2: band("spo2"),
  };

  const MIN_PP = 20;
  if (out.sbp - out.dbp < MIN_PP) {
    const target = out.sbp - MIN_PP;
    out.dbp = Math.max(target - (target % 2), v.dbp[0]);
  }

  if ("armDiff" in v) {
    out.armDiff = randint(v.armDiff[0], v.armDiff[1]);
  }

  const shifts = [];
  for (const [key, val] of Object.entries(slots || {})) {
    if (val && typeof val === "object" && val.vitalsShift) shifts.push([key, val.vitalsShift]);
  }
  const bounds = v.shiftBounds || {};
  for (const [key, sh] of shifts) {
    for (const [field, delta] of Object.entries(sh)) {
      if (!(field in out) || field === "invariant") continue;
      const [lo, hi] = bounds[field] || v[field] || [out[field], out[field]];
      let moved = out[field] + delta;
      moved = Math.max(Math.min(moved, hi), lo);
      out[field] = field === "temp" ? Math.round(moved * 10) / 10 : Math.round(moved);
    }
    (out._shiftedBy ||= []).push(key);
  }

  out.invariant = v.invariant || "";
  return out;
}

function resolveFindings(scenario, slots) {
  const out = {};
  const rolled = [];
  for (const [key, val] of Object.entries((scenario.pe || {}).findings || {})) {
    if (val && typeof val === "object" && "p" in val) {
      const hit = Math.random() < parseFloat(val.p);
      out[key] = fill(hit ? val.detected : val.notDetected, slots);
      rolled.push([key, hit, parseFloat(val.p)]);
    } else {
      out[key] = fill(val, slots);
    }
  }
  return { findings: out, rolled };
}

// ---------------------------------------------------------------- 슬롯 치환 (조사 처리)

const JOSA_PAIRS = {
  이: ["이", "가"], 가: ["이", "가"], 은: ["은", "는"], 는: ["은", "는"],
  을: ["을", "를"], 를: ["을", "를"], 과: ["과", "와"], 와: ["과", "와"],
  이라고: ["이라고", "라고"], 라고: ["이라고", "라고"],
  이면: ["이면", "면"], 면: ["이면", "면"],
};
const SLOT_RE = /\{\{(\w+)\}\}(?:(이라고|라고|이면|면|으로|로|이|가|은|는|을|를|과|와)(?![가-힣]))?/g;

function hasBatchim(word) {
  const chars = [...(word || "")].reverse();
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
    if (ch >= "0" && ch <= "9") return !"2459".includes(ch);
    if (/[a-zA-Z]/.test(ch)) return false;
  }
  return null;
}

function fill(text, slots) {
  if (typeof text !== "string") return text;

  function one(match, key, josa) {
    if (!(key in slots)) return match;
    let val = slots[key];
    if (val && typeof val === "object" && !Array.isArray(val)) val = val.text || "";
    val = String(val);
    if (!josa) return val;
    const bat = hasBatchim(val);
    if (bat === null) return val + josa;
    if (josa === "으로" || josa === "로") {
      const last = val[val.length - 1] || "";
      const code = last.codePointAt(0);
      const rieul = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8;
      return val + (bat && !rieul ? "으로" : "로");
    }
    const [a, b] = JOSA_PAIRS[josa];
    return val + (bat ? a : b);
  }

  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(SLOT_RE, one);
  }
  return text;
}

function fillDeep(node, slots) {
  if (Array.isArray(node)) return node.map((x) => fillDeep(x, slots));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillDeep(v, slots);
    return out;
  }
  return fill(node, slots);
}

// ---------------------------------------------------------------- 조립

export function buildCase(topicFile, data, personas, scenarioId) {
  const pool = data.scenarios;
  let scenario = scenarioId ? pool.find((s) => s.id === scenarioId) : null;
  if (!scenario) scenario = choice(pool);

  const person = drawPerson(scenario, personas);
  const slots = drawSlots(scenario, person);
  if ("age" in slots) slots.age = person.age;
  if ("sexText" in slots) slots.sexText = person.sex === "male" ? "남성" : "여성";

  for (const key of ["smoking", "alcohol"]) {
    if (person[key].id === "card") {
      person[key] = { ...person[key], label: fill(person[key].label, slots) };
    }
  }

  person.slots = slots;
  const guardian = drawGuardian(scenario, person, personas, slots);
  if (guardian) {
    person.guardian = guardian;
    person.speaksForSelf = person.age >= 13;
  }
  person.iceOwner = guardian && !person.speaksForSelf ? "보호자" : "환자";

  const problems = [];
  validate(person, scenario, personas, problems);

  const { findings, rolled } = resolveFindings(scenario, slots);
  return {
    topic: data.topic, topicFile,
    scenario, person, slots,
    vitals: drawVitals(scenario, person, slots),
    findings, rolled, problems,
    // _peRules 는 시나리오가 아니라 카드 파일(주호소) 최상위에 있다 — 조합기가 손대지
    // 않는 필드라 원본 그대로 들고 다닌다 (SKILL.md 도 이걸 시나리오 밖에서 읽는다).
    peRules: data._peRules || null,
  };
}

/** 스킬(시스템 프롬프트)이 그대로 읽을 수 있는 형태로 조합 결과를 펼친다. */
export function caseToPrompt(kase) {
  const s = kase.scenario, p = kase.person, slots = kase.slots;
  const { pe: _pe, variations: _v, constraints: _c, occupationBias: _o, iceHint: _i, ...rest } = s;
  const filled = fillDeep(rest, slots);

  const person = {
    name: p.name, age: p.age, sex: p.sex === "male" ? "남" : "여",
    occupation: p.occupation.label,
    personality: p.personality.label, personalityVoice: p.personality.voice,
    healthLiteracy: p.healthLiteracy.label, healthLiteracyVoice: p.healthLiteracy.voice,
    ice: p.ice.idea, iceOwner: p.iceOwner || "환자",
    backgroundIllness: p.illness.label,
    smoking: p.smoking.label, alcohol: p.alcohol.label,
    forcedRisk: p.forcedRisk || [],
  };
  if (p.guardian) {
    const g = p.guardian;
    person.guardian = {
      age: g.age, sex: g.sex === "female" ? "여" : "남",
      occupation: (g.occupation || {}).label || "-",
      personality: g.personality.label, personalityVoice: g.personality.voice,
      healthLiteracy: g.healthLiteracy.label, healthLiteracyVoice: g.healthLiteracy.voice,
      role: g.role,
    };
    if (g.voiceWins) person.guardian.voiceWins = true;
    person.speaksForSelf = p.speaksForSelf ?? true;
  }

  const cardPmh = stripDirectives(fill(s.pmh || "", slots));
  const illnessLabel = p.illness.label;
  const parts = [];
  const segs = cardPmh.split(/(?<=[.。])\s+/).map((x) => x.trim()).filter(Boolean);
  const kept0 = segs.filter((x) => !NONE_PMH_RE.test(x.replace(/[.。]+$/, "")));
  if (illnessLabel && illnessLabel !== "없음" && !cardPmh.includes(illnessLabel)) parts.push(illnessLabel);
  if (cardPmh) {
    if (!parts.length) parts.push(cardPmh);
    else if (kept0.length) parts.push(kept0.join(" "));
  }
  person.pmhResolved = parts.length ? parts.join(". ") : "특이 병력 없음";

  const medsCard = stripDirectives(fill(s.meds || "", slots));
  let medList = (p.illness.meds || []).slice();
  const shCard = stripDirectives(fill(s.sh || "", slots));
  const shBase = p.age < ADULT_AGE
    ? `직업 ${p.occupation.label}`
    : `직업 ${p.occupation.label} · 흡연 ${p.smoking.label} · 음주 ${p.alcohol.label}`;
  person.shResolved = (shBase + (shCard ? ". " + shCard : "")).trim();

  let kept = medsCard.split(/(?<=[.。])\s+|\.\s*$/).map((x) => x.trim()).filter(Boolean);
  kept = kept.filter((x) => !NONE_MEDS_RE.test(x));
  const cardIsNone = NONE_MEDS_RE.test(medsCard.trim()) || !kept.length;
  if (s._ownMeds) {
    person.medsResolved = kept.join(" ") || medsCard;
    medList = [];
  }
  if (medList.length && cardIsNone) {
    person.medsResolved = medList.join(", ");
  } else if (medList.length && medsCard) {
    person.medsResolved = medList.join(", ") + ". " + kept.join(" ");
  } else {
    person.medsResolved = (medList.join(", ") || medsCard).trim() || "복용 약 없음";
  }

  const pe = { ...(s.pe || {}) };
  delete pe.vitals;
  delete pe.findings;
  const peFilled = fillDeep(pe, slots);
  // 술기 카드처럼 활력징후 밴드 자체가 없는 경우(_raw 가 null/undefined 이고 sbp 도 없음)만
  // vitals 를 안 붙인다. 그 외(정상 케이스)는 뽑힌 값을 그대로 붙인다.
  const v = kase.vitals || {};
  const noVitals = (v._raw === undefined || v._raw === null) && !("sbp" in v);
  if (!noVitals) peFilled.vitals = v;
  if (Object.keys(kase.findings).length) peFilled.findings = kase.findings;

  for (const [key, resolved] of [["pmh", "pmhResolved"], ["meds", "medsResolved"], ["sh", "shResolved"]]) {
    if (person[resolved] !== undefined) filled[key] = person[resolved];
  }

  return {
    topic: kase.topic, topicFile: kase.topicFile,
    scenarioId: s.id, dx: s.dx || s.situation,
    person, scenario: filled, pe: peFilled, peRules: kase.peRules,
    rolledProbabilistic: (kase.rolled || []).map(([finding, detected, p2]) => ({ finding, detected, p: p2 })),
    problems: kase.problems,
  };
}

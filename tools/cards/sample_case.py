# -*- coding: utf-8 -*-
"""케이스 카드 샘플러 · 규칙 검증기

카드(진단 시나리오) + personas.json(인물) + variations(표현 변주)를 조합해
한 세션 분량의 완성된 환자 설정을 만든다. personas.json 의 _validation 규칙을
여기서 실제로 강제한다 — 규칙이 문서에만 있으면 지켜지지 않는다.

이 파일은 같은 저장소의 src/sampleCase.js 와 1:1 로 맞춰져 있다 (카드 점검이 실제
면담과 같은 규칙으로 돌게 하기 위해서). 자동 동기화가 없으므로 한쪽을 고치면
다른 쪽도 같이 고칠 것. (pre-push 훅이 둘 중 하나가 바뀌면 알려준다.)

사용법
    python sample_case.py                     무작위 주호소 하나를 뽑아 출력
    python sample_case.py 01-chest-pain       해당 주호소에서 뽑아 출력
    python sample_case.py 01-chest-pain chest-mi   시나리오까지 지정
    python sample_case.py --check 2000        전 카드에서 N회 뽑아 규칙 위반을 보고
    python sample_case.py 01-chest-pain --json  스킬이 그대로 읽을 JSON 으로 출력
"""
from __future__ import unicode_literals
import io, json, os, random, re, sys, glob

# 윈도우 콘솔 기본 코드페이지(cp949)에서 한글·기호 출력이 죽지 않게 한다.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.normpath(os.path.join(HERE, "..", "..", "src", "cases"))

MAX_RETRY = 20          # 항목 단위 재추첨 한도
# "약이 없다" 는 말의 여러 꼴. 배경질환 약 뒤에 이 말이 붙으면 모순이 된다.
# 과거력 칸의 "없음" 문장. 배경질환이 앞에 붙으면 이 문장만 떼어 낸다.
NONE_PMH_RE = re.compile(
    r"^(특이 병력 없음|특이사항 없음|특별한 병력? 없음|특별한 병은 없어요|"
    r"큰 병력 없음|병력 없음|특이사항 없어요|없음)$")

NONE_MEDS_RE = re.compile(
    r"^(복용\s*중인\s*|복용\s*|따로\s*|그\s*밖에\s*|새로\s*먹기\s*시작한\s*|챙겨\s*|"
    r"먹는\s*|드시는\s*)*약(은|이)?\s*(따로\s*)?(없(음|어요|습니다|다)|안\s*먹(어요|습니다|음|는다))\.?$"
    r"|^(복용\s*약\s*)?없(음|어요|습니다)\.?$")

SMOKING_START_AGE = 19  # 흡연 기간이 (나이 - 이 값) 을 넘으면 모순
ADULT_AGE = 19          # 이 아래는 사회력에 흡연·음주를 적지 않는다


def load(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def topic_files():
    out = []
    for p in sorted(glob.glob(os.path.join(CASES, "*.json"))):
        if os.path.basename(p) in ("personas.json", "index.json"):
            continue
        d = load(p)
        if d.get("scenarios"):
            out.append((os.path.basename(p)[:-5], d))
    return out


# ---------------------------------------------------------------- 추첨 보조

def scenario_ice(scenario, person=None):
    """시나리오 카드의 ice {ideas, concerns, expectations} 에서 하나씩 뽑아 한 줄로 만든다.
    셋 중 하나라도 비어 있으면 None — 그 시나리오는 인물 성향 ICE 를 그대로 쓴다.
    cpx-worker 의 sampleCase.js scenarioIce() 와 같은 형식이어야 한다."""
    ice = scenario.get("ice") or {}
    picks = []
    for k in ("ideas", "concerns", "expectations"):
        opts = ice.get(k) or []
        if not opts:
            return None
        # 값이 {"text", "occOnly"…} 이면 변주와 같은 조건을 본다. 주부·은퇴자가
        # "일을 며칠 못 나갈까 봐" 걱정했다. 다 걸러지면 원래 목록을 쓴다.
        if person is not None:
            opts = [o for o in opts if allowed(o, person)] or opts
        pick = random.choice(opts)
        picks.append(pick["text"] if isinstance(pick, dict) else pick)
    return {"id": "scenario",
            "idea": "생각(원인): %s / 걱정: %s / 기대: %s" % tuple(picks)}


def weighted(pool):
    """weight 필드를 존중해 하나 고른다. weight 가 없으면 1로 본다."""
    bag = []
    for item in pool:
        bag.extend([item] * int(item.get("weight", 1)))
    return random.choice(bag)


def years_in(label):
    """'하루 한 갑 이상, 20년 이상' → 20. 숫자가 없으면 0."""
    m = re.findall(r"(\d+)\s*년", label or "")
    return max(int(x) for x in m) if m else 0


def age_ok(item, age, sex=None):
    """나이 하한. femaleMinAge 가 있으면 여성에게는 그 값을 쓴다 (예: 통풍은 폐경 전 여성에게 드물다)."""
    floor = item.get("femaleMinAge") if sex == "female" and item.get("femaleMinAge") is not None else item.get("minAge", 0)
    return age >= int(floor)


def occupation_ok(occ, age):
    lo, hi = occ.get("ageRange", [0, 200])
    return lo <= age <= hi


# ---------------------------------------------------------------- 검증

def incompatible_pairs(personas):
    """_incompatible 을 (종류:id, 종류:id) 집합으로 바꾼다."""
    pairs = set()
    for rule in personas.get("_incompatible", []):
        a, b = rule["a"], rule["b"]
        pairs.add(frozenset([a, b]))
    return pairs


def person_tokens(p):
    return {
        "personality:" + p["personality"]["id"],
        "healthLiteracy:" + p["healthLiteracy"]["id"],
        "ice:" + p["ice"]["id"],
        "occupation:" + p["occupation"]["id"],
    }


# 카드 작성자가 모델에게 남긴 지시문. 학생이 읽으면 안 된다.
# "인물 카드를 따르되 ..." 처럼 뒤에 실제 내용이 붙는 형태는 앞부분만 떼고,
# 문장 전체가 지시문이면 문장째 버린다.
DIRECTIVE_PREFIXES = (r"^인물 카드를 따르되[,]?\s*", r"^인물 카드를 따름[.,]?\s*")
DIRECTIVE_MARKS = ("인물 카드", "덮어쓴다", "그대로 쓴다", "변주를 쓴다", "변주는",
                   "확인이 중요", "로 읽는다", "항목을 따르", "필수", "반드시",
                   # 맨 "보유"만 걸면 "위험인자 보유", "B형 간염 보유자" 같은 정상 문장이
                   # 지시문으로 오인돼 통째로 사라진다("고혈압 등 위험인자 보유"가
                   # 지워져 과거력이 "고혈압"만 남았다). 카드 저자가 실제로 쓰는
                   # "하나 이상 보유"/"2개 이상 보유" 요구 문구만 좁혀서 잡는다.
                   "이상 보유")


def strip_directives(text):
    """지시문 문장을 걷어낸다. 마침표가 없는 마지막 문장도 본다."""
    if not text:
        return ""
    for pat in DIRECTIVE_PREFIXES:
        text = re.sub(pat, "", text)
    kept = [s for s in re.split(r"(?<=\.)\s+", text)
            if s.strip() and not any(m in s for m in DIRECTIVE_MARKS)]
    return " ".join(kept).strip()


def validate(person, scenario, personas, problems):
    """규칙 위반을 problems 리스트에 문자열로 쌓는다."""
    age = person["age"]

    if not occupation_ok(person["occupation"], age):
        problems.append("직업-나이: %s / %d세" % (person["occupation"]["label"], age))

    for key in ("smoking", "alcohol", "illness"):
        item = person[key]
        if not age_ok(item, age, person.get("sex")):
            problems.append("%s-나이: %s / %d세 (minAge %s)"
                            % (key, item["label"], age, item.get("minAge")))

    yrs = years_in(person["smoking"]["label"])
    if yrs and yrs > age - SMOKING_START_AGE:
        problems.append("흡연기간: %d년 / %d세" % (yrs, age))

    toks = person_tokens(person)
    for pair in incompatible_pairs(personas):
        if pair <= toks:
            problems.append("상충 조합: %s" % " + ".join(sorted(pair)))

    sex = person["sex"]
    for slot, val in person["slots"].items():
        if isinstance(val, dict):
            only = val.get("sexOnly")
            if only and only != sex:
                problems.append("성별 제한 변주: %s (%s 전용인데 %s)" % (slot, only, sex))
            cap = val.get("maxAge")
            if cap is not None and age > cap:
                problems.append("연령 제한 변주: %s (최대 %s세인데 %d세)" % (slot, cap, age))
            floor = val.get("minAge")
            if floor is not None and age < floor:
                problems.append("연령 제한 변주: %s (최소 %s세인데 %d세)" % (slot, floor, age))

    c = scenario["constraints"]
    lo, hi = c["ageRange"]
    if not (lo <= age <= hi):
        problems.append("시나리오 연령 범위 밖: %d세 (%d~%d)" % (age, lo, hi))
    if c.get("sex", "any") != "any" and c["sex"] != sex:
        problems.append("시나리오 성별 불일치")

    banned = set(c.get("forbidden") or [])
    ill = person["illness"]
    if ill["id"] in banned or ill["label"] in banned:
        problems.append("카드가 금지한 지병: %s" % ill["label"])

    # 요구한 위험인자가 사람에게 실제로 붙었는지 본다. 조용히 넘어가면
    # 간경변 환자가 "안 마심" 으로 나온 것을 아무도 모른다.
    for r in (person.get("forcedRisk") or []):
        want = RISK_ALIAS.get(r, r)
        # 카드가 alcoholLabel / smokingLabel 로 직접 적어 준 값은 id 가 "card" 다
        if want in ("음주", "과음"):
            ok = person["alcohol"]["id"] in (
                ("heavy", "card") if want == "과음" else ("social", "heavy", "card"))
        elif want in ("흡연", "흡연:heavy"):
            ok = person["smoking"]["id"] in (
                ("light", "heavy", "card") if want.endswith("heavy")
                else ("light", "heavy", "ex", "occasional", "card"))
        else:
            ok = person["illness"]["label"] == want or person["illness"]["id"] == want
        if not ok:
            problems.append("요구한 위험인자 미적용: %s" % r)

    # 카드가 요구한 흡연·음주를 못 맞추면 조용히 넘어가지 않는다.
    # 넘어가면 "비흡연" 인 사람이 금연 상담을 받으러 온 카드가 만들어진다.
    for key in ("smoking", "alcohol"):
        want = c.get(key)
        if want and not c.get(key + "Label"):
            if person[key]["id"] not in HABIT_IDS[key].get(want, ()):
                problems.append("카드가 요구한 %s(%s) 미적용: %s"
                                % (key, want, person[key]["label"]))

    v = (scenario.get("pe") or {}).get("vitals")
    if isinstance(v, dict):
        for k in ("sbp", "dbp", "hr", "rr", "temp", "spo2"):
            if k not in v:
                problems.append("활력징후 밴드 누락: %s" % k)
        if "invariant" not in v:
            problems.append("활력징후 invariant 누락")
    elif scenario.get("pe"):
        problems.append("활력징후 형식: 밴드가 아님")

    for key, val in ((scenario.get("pe") or {}).get("findings") or {}).items():
        if isinstance(val, dict):
            if not (0.0 < float(val.get("p", 0)) < 1.0):
                problems.append("확률 소견 p 범위: %s" % key)
            for need in ("detected", "notDetected"):
                if not val.get(need):
                    problems.append("확률 소견 %s 누락: %s" % (need, key))


# ---------------------------------------------------------------- 인물 추첨

def draw_person(scenario, personas):
    c = scenario["constraints"]
    lo, hi = c["ageRange"]
    age = random.randint(lo, hi)

    sex = c.get("sex", "any")
    if sex == "any":
        sex = random.choice(["male", "female"])

    surname = random.choice(personas["surnames"])
    pool = personas["givenNames"]["male" if sex == "male" else "female"]
    if isinstance(pool, dict):
        band = "young" if age <= 25 else ("mid" if age <= 55 else "old")
        given = random.choice(pool[band])
    else:
        given = random.choice(pool)   # 예전 평면 배열 형식도 계속 읽는다

    # 직업 — occupationBias 를 60% 확률로 존중하되 나이에 맞는 것만.
    # sexWeight 가 있으면 성비로 저울질한다 (0 은 없으므로 드문 조합도 나온다).
    def by_sex(pool):
        bag = []
        for o in pool:
            w = int((o.get("sexWeight") or {}).get(sex, 1))
            bag.extend([o] * max(w, 1))
        return random.choice(bag) if bag else None

    bias = [o for o in personas["occupations"]
            if o["id"] in scenario.get("occupationBias", []) and occupation_ok(o, age)]
    allowed = [o for o in personas["occupations"] if occupation_ok(o, age)]
    # 카드 전체가 직업을 전제하면 occupationOnly 로 못박는다. occupationBias 는 60% 만
    # 존중해서, 교대근무 불면 카드에 주부·건설 일용직이 "3교대 근무예요" 라고 했다.
    only = c.get("occupationOnly")
    if only:
        fixed = [o for o in allowed if o["id"] in only]
        if fixed:
            bias, allowed = fixed, fixed
    if not allowed:
        # 나이에 맞는 직업이 하나도 없으면 아무거나 고르지 않고 가장 가까운 것을 쓴다.
        # 예전에는 전체에서 뽑아 나이 제약이 조용히 무시됐다.
        def distance(o):
            lo, hi = o.get("ageRange", [0, 200])
            return (lo - age) if age < lo else (age - hi)
        allowed = sorted(personas["occupations"], key=distance)[:3]
    occupation = by_sex(bias) if (bias and random.random() < 0.6) else by_sex(allowed)

    personality = random.choice(personas["personalities"])
    literacy = weighted(personas["healthLiteracy"])

    hints = scenario.get("iceHint") or []
    ice_pool = [i for i in personas["iceStyles"] if i["id"] in hints] or personas["iceStyles"]
    ice = random.choice(ice_pool)

    def pick_aged(key):
        pool = [x for x in personas[key] if age_ok(x, age, sex)]
        return weighted(pool or [personas[key][0]])

    # 카드가 금지한 지병은 애초에 뽑지 않는다. 갑상선기능항진증 케이스에
    # 갑상선기능저하증 병력이 붙으면 진단 자체가 무너진다.
    banned = set(c.get("forbidden") or [])
    ill_pool = [x for x in personas["backgroundIllness"]
                if age_ok(x, age, sex) and x["id"] not in banned and x["label"] not in banned]
    illness = weighted(ill_pool) if ill_pool else pick_aged("backgroundIllness")
    smoking = pick_aged("smoking")
    alcohol = pick_aged("alcohol")

    # 흡연 기간이 나이를 넘지 않도록 다시 뽑는다
    tries = 0
    while years_in(smoking["label"]) > age - SMOKING_START_AGE and tries < MAX_RETRY:
        smoking = pick_aged("smoking")
        tries += 1

    person = {
        "name": surname + given, "age": age, "sex": sex,
        "occupation": occupation, "personality": personality,
        "healthLiteracy": literacy, "ice": ice,
        "illness": illness, "smoking": smoking, "alcohol": alcohol,
    }

    # 상충 조합이 나오면 뒤쪽 항목만 다시 뽑는다
    pairs = incompatible_pairs(personas)
    tries = 0
    while tries < MAX_RETRY:
        toks = person_tokens(person)
        hit = [p for p in pairs if p <= toks]
        if not hit:
            break
        # ICE 후보가 하나뿐인 시나리오(iceHint 가 좁을 때)에서는 ice 만 다시 뽑아도
        # 영원히 못 빠져나온다. 성격도 함께 다시 뽑는다.
        person["ice"] = random.choice(ice_pool)
        person["healthLiteracy"] = weighted(personas["healthLiteracy"])
        person["personality"] = random.choice(personas["personalities"])
        tries += 1

    # 시나리오가 요구하는 위험인자를 마지막에 덮어쓴다
    required = list(c.get("requiredRisk", []))
    need = int(c.get("requiredRiskMin", 0))
    forced = []
    if required and need:
        # 사람의 지병은 하나뿐이다. 지병 요구를 둘 뽑으면 뒤엣것이 앞엣것을 덮어
        # 하나는 반드시 어긋난다(혈관성 치매 카드가 고혈압과 당뇨를 함께 요구했다).
        habit = [r for r in required
                 if RISK_ALIAS.get(r, r) in ("흡연", "흡연:heavy", "음주", "과음")]
        illness = [r for r in required if r not in habit]
        # 습관과 지병을 나란히 놓고 need개를 고른다. 습관을 먼저 채우던 예전
        # 방식은 습관 개수가 need 이상이면 지병이 한 번도 안 뽑혔다 — SAH 카드가
        # "고혈압"·"흡연" 중 하나를 요구했는데 흡연만 매번 걸리고 고혈압은
        # 죽은 코드였다. 지병은 한 자리로만 묶어 여전히 하나만 뽑히게 한다.
        pool = list(habit) + (["__illness__"] if illness else [])
        picked = random.sample(pool, min(need, len(pool)))
        forced = [r for r in picked if r != "__illness__"]
        if "__illness__" in picked:
            forced.append(random.choice(illness))
        for r in forced:
            want = RISK_ALIAS.get(r, r)
            if want in ("흡연", "흡연:heavy"):
                ids = (("light", "heavy") if want.endswith("heavy")
                       else ("occasional", "light", "heavy", "ex"))
                pool = [s for s in personas["smoking"]
                        if s["id"] in ids and age_ok(s, age)
                        and years_in(s["label"]) <= age - SMOKING_START_AGE]
                if pool:
                    person["smoking"] = random.choice(pool)
            # 음주 요구는 배경질환에서 찾다가 조용히 넘어가고 있었다. 그래서
            # 간경변 환자가 "안 마심" 으로, 알코올 금단 환자가 "안 마심" 으로 나왔다.
            elif want in ("음주", "과음"):
                ids = ("heavy",) if want == "과음" else ("social", "heavy")
                pool = [a for a in personas["alcohol"] if a["id"] in ids and age_ok(a, age)]
                if pool:
                    person["alcohol"] = random.choice(pool)
            else:
                match = [b for b in personas["backgroundIllness"]
                         if (b["label"] == want or b["id"] == want) and age_ok(b, age)]
                if match:
                    person["illness"] = match[0]
    # 표시는 사람이 읽는 이름으로. id 로 적힌 카드가 있어 "smoking, dm" 이 그대로 나왔다.
    person["forcedRisk"] = [RISK_ALIAS.get(r, r) for r in forced]

    # 카드가 흡연·음주를 요구하면 여기서 값으로 확정한다. 예전에는 이 요구가 sh 에
    # 문장으로만 적혀 있어 실행되지 않았고, 금연 상담 카드의 환자가 "비흡연"으로 나왔다.
    force_habit(person, "smoking", c.get("smoking"), c.get("smokingLabel"), personas, age)
    force_habit(person, "alcohol", c.get("alcohol"), c.get("alcoholLabel"), personas, age)

    return person


HABIT_IDS = {
    "smoking": {"current": ("occasional", "light", "heavy"),
                "ever": ("occasional", "light", "heavy", "ex"),
                "heavy": ("light", "heavy"),
                "notCurrent": ("never", "ex"),
                "never": ("never",)},
    "alcohol": {"drinker": ("social", "heavy"),
                "heavy": ("heavy",),
                # 폭음이 섞이면 체중감소·탈수를 술로 설명하게 되어 초점이 흐려지는
                # 카드가 있다(방임 노인). 그럴 때 쓴다.
                "notHeavy": ("none", "social"),
                "never": ("none",)},
}


def force_habit(person, key, want, label, personas, age):
    """카드가 지정한 흡연·음주를 사람에게 실제로 적용한다."""
    if label:
        person[key] = {"id": "card", "label": label, "minAge": 0}
        return
    ids = HABIT_IDS[key].get(want or "")
    if not ids:
        return
    pool = [x for x in personas[key] if x["id"] in ids and age_ok(x, age)]
    if key == "smoking":
        pool = [x for x in pool if years_in(x["label"]) <= age - SMOKING_START_AGE]
    if pool:
        person[key] = weighted(pool)


def draw_guardian(scenario, person, personas, slots):
    """보호자를 뽑는다. 관계 이름이 슬롯일 수 있으므로 치환이 끝난 뒤에 부른다.
    치환 전에 부르면 '{{caregiver}}' 를 못 읽어 나이 방향이 뒤집힌다."""
    info = fill_deep(scenario.get("informant"), slots)
    if not info:
        return None
    age = person["age"]
    rel = str(info.get("relation") or "") if isinstance(info, dict) else str(info)

    YOUNGER = ("딸", "아들", "자녀", "며느리", "사위", "손자", "손녀", "조카")
    OLDER = ("어머니", "아버지", "엄마", "아빠", "부모", "할머니", "할아버지")
    SAME = ("배우자", "남편", "아내", "형", "누나", "언니", "오빠", "동생", "친구", "이웃", "동료")

    if any(w in rel for w in SAME):
        kind = "same"
    elif any(w in rel for w in YOUNGER):
        kind = "younger"
    elif any(w in rel for w in OLDER):
        kind = "older"
    else:
        kind = "younger" if age >= 60 else ("older" if age <= 17 else "same")

    if kind == "younger":
        lo, hi = age - 40, age - 22
        g_sex = "female" if random.random() < 0.6 else "male"
    elif kind == "same":
        lo, hi = age - 8, age + 8
        g_sex = "male" if random.random() < 0.5 else "female"
    else:
        lo, hi = age + 22, age + 40
        g_sex = "female" if random.random() < 0.7 else "male"
    # 손아래·손위 형제는 "같은 또래" 범위에서 방향만 정한다. 76세 환자의 여동생이 80세로 나왔다.
    if "동생" in rel:
        lo, hi = age - 12, age - 1
    elif any(w in rel for w in ("형", "누나", "언니", "오빠")):
        lo, hi = age + 1, age + 12

    # 관계가 성별을 정하는 경우에는 추첨 결과를 덮어쓴다.
    # 예전에는 '딸'인데 남자 보호자가 나왔다.
    FEMALE_REL = ("딸", "며느리", "여동생", "어머니", "엄마", "아내", "누나", "언니", "할머니", "이모", "고모")
    MALE_REL = ("아들", "사위", "남동생", "아버지", "아빠", "남편", "형", "오빠", "할아버지", "삼촌")
    if any(w in rel for w in FEMALE_REL):
        g_sex = "female"
    elif any(w in rel for w in MALE_REL):
        g_sex = "male"
    elif "배우자" in rel:
        # 성별이 안 드러나는 관계 이름이라 추첨에 맡겼더니 여성 환자에게 여성 배우자가 나왔다.
        g_sex = "male" if person["sex"] == "female" else "female"

    lo, hi = max(lo, 22), min(hi, 88)
    if lo > hi:
        lo = hi = max(22, min(88, hi))
    g_age = random.randint(lo, hi)

    # 보호자 직업도 성비를 반영한다. 예전에는 55세 여성 보호자가 용접공으로 나왔다.
    g_occ = [o for o in personas["occupations"] if occupation_ok(o, g_age)]
    bag = []
    for o in g_occ:
        w = int((o.get("sexWeight") or {}).get(g_sex, 1))
        bag.extend([o] * max(w, 1))

    # 성격과 건강정보 수준을 환자에게서 물려받으면 두 사람이 늘 같은 사람이 된다.
    # 따로 뽑아야 "축소하는 환자와 걱정 많은 보호자" 같은 조합이 나온다.
    g_person = random.choice(personas["personalities"])
    g_lit = weighted(personas["healthLiteracy"])

    out = {
        "age": g_age, "sex": g_sex,
        "occupation": random.choice(bag) if bag else None,
        "personality": g_person,
        "healthLiteracy": g_lit,
        "role": info,
    }
    # 카드에 보호자 voice 가 있으면 그것이 태도를 정한다. 뽑힌 성격은 말투만 물들인다.
    # 둘이 부딪히면(걱정 많은 보호자인데 축소형) voice 가 이긴다.
    if isinstance(info, dict) and (info.get("voice") or info.get("style")):
        out["voiceWins"] = True
    return out


# ---------------------------------------------------------------- 변주·활력징후

# 카드가 requiredRisk 에 쓰는 여러 표기를 한 가지로 모은다.
# id 로 적힌 것("htn")이 배경질환 라벨("고혈압")과 안 맞아 무시되고 있었다.
RISK_ALIAS = {"smoking": "흡연", "smoking:heavy": "흡연:heavy", "alcohol": "음주",
              "htn": "고혈압", "dm": "당뇨병", "dyslip": "이상지질혈증",
              "thyroid": "갑상선기능저하증", "gout": "통풍", "depress": "우울증"}

OCC_GROUPS = {
    "학생": ("student", "highschool", "middleschool", "elementary"),
    "사무실": ("office", "teacher", "nurse", "selfemp"),
    "현장": ("farmer", "construct", "market", "welder", "cook",
           "delivery", "driver", "care", "soldier"),
    "집": ("housewife", "retired", "jobless"),
}


def allowed(v, person):
    """이 값이 이 사람에게 쓸 수 있는가. 성별·연령·직업 제한을 본다."""
    if not isinstance(v, dict):
        return True
    if v.get("sexOnly") and v["sexOnly"] != person["sex"]:
        return False
    # 직업과 안 맞는 상황문을 막는다. 배달 라이더가 학교 강의실에서 쓰러졌다고 했다.
    want = v.get("occOnly")
    if want:
        ids = set()
        for w in ([want] if isinstance(want, str) else want):
            ids.update(OCC_GROUPS.get(w, (w,)))
        if person["occupation"]["id"] not in ids:
            return False
    if v.get("maxAge") is not None and person["age"] > v["maxAge"]:
        return False
    if v.get("minAge") is not None and person["age"] < v["minAge"]:
        return False
    # 술을 전제한 답. 비음주 인물이 "예전엔 더 드셨는데… 술은 안 드세요"라고 했다.
    if v.get("drinkerOnly") and person["alcohol"]["id"] == "none":
        return False
    return True


def draw_slots(scenario, person):
    """variations 에서 슬롯값을 하나씩 뽑는다. 성별·연령 제한이 붙은 값은 거른다."""
    slots = {}
    for key, pool in (scenario.get("variations") or {}).items():
        candidates = [v for v in pool if allowed(v, person)]
        if not candidates:
            candidates = [x for x in pool if not isinstance(x, dict)] or [""]
        slots[key] = random.choice(candidates)

    # 사람에게서 바로 나오는 값들. 카드가 같은 이름의 변주를 두면 그쪽이 이긴다.
    # 이게 없어서 카드가 답변 자리에 "인물 카드를 따름" 이라고 적어 두었고,
    # 손위 형제 호칭이 성별과 어긋나 남성 환자가 "언니" 라고 불렀다.
    auto = {
        "smoking": person["smoking"]["label"],
        "alcohol": person["alcohol"]["label"],
        "olderBro": "형" if person["sex"] == "male" else "오빠",
        "olderSis": "누나" if person["sex"] == "male" else "언니",
        "spouse": "아내" if person["sex"] == "male" else "남편",
        "inlaws": "처가" if person["sex"] == "male" else "시댁",
        # 카드가 문장 안에 넣어 쓰도록 자연스러운 꼴로도 준다.
        # 라벨을 그대로 끼우면 "안 마심 정도 드세요" 가 된다.
        # 라벨이 이미 "…1병 이상" 으로 끝나면 "정도" 를 또 붙이지 않는다.
        # "소주 1병 이상 정도 마셔요" 가 됐다.
        "alcoholSay": ("술은 안 마셔요." if person["alcohol"]["label"] == "안 마심"
                       else "술은 %s%s 마셔요." % (person["alcohol"]["label"],
                                                "" if person["alcohol"]["label"].endswith("이상") else " 정도")),
        "alcoholSayHon": ("술은 안 드세요." if person["alcohol"]["label"] == "안 마심"
                          else "술은 %s%s 드세요." % (person["alcohol"]["label"],
                                                   "" if person["alcohol"]["label"].endswith("이상") else " 정도")),
        # "ex" 는 라벨이 "과거 흡연 (끊은 지 몇 년)" 이라 그대로 끼우면
        # "담배는 과거 흡연 (끊은 지 몇 년) 피워요" 가 된다. 따로 문장을 만든다.
        "smokingSay": ("담배는 안 피워요." if person["smoking"]["id"] == "never"
                       else "예전엔 피웠는데 끊었어요." if person["smoking"]["id"] == "ex"
                       else "담배는 %s 피워요." % person["smoking"]["label"]),
    }
    for k, v in auto.items():
        slots.setdefault(k, v)

    # 함께 움직여야 하는 슬롯은 같은 자리에서 뽑는다. 따로 뽑으면
    # "다리는 별 이상 없어요" 와 "한쪽 종아리가 굵고 압통" 이 같이 나온다.
    pools = scenario.get("variations") or {}
    for group in (scenario.get("pairedVariations") or []):
        keys = [k for k in group if k in pools]
        if len(keys) < 2:
            continue
        # 짝을 맞추더라도 성별·연령 제한은 그대로 지킨다.
        # 안 지키면 남성이 "유방암 치료를 받았어요" 로 짝지어진다.
        usable = [i for i in range(min(len(pools[k]) for k in keys))
                  if all(allowed(pools[k][i], person) for k in keys)]
        if not usable:
            continue
        idx = random.choice(usable)
        for k in keys:
            slots[k] = pools[k][idx]
    return slots


def draw_vitals(scenario, person, slots=None):
    v = (scenario.get("pe") or {}).get("vitals")
    if not isinstance(v, dict):
        return {"_raw": v}

    def band(key, step=1):
        lo, hi = v[key]
        if isinstance(lo, float) or isinstance(hi, float):
            return round(random.uniform(lo, hi), 1)
        val = random.randint(int(lo), int(hi))
        return val - (val % step)

    sbp = band("sbp", 2)
    bonus = 0
    if person["illness"]["label"] == "고혈압":
        bonus += random.randint(5, 15)
    if person["age"] >= 70:
        bonus += random.randint(0, 10)
    sbp = min(sbp + bonus, int(v["sbp"][1]))
    sbp -= sbp % 2

    out = {
        "sbp": sbp, "dbp": band("dbp", 2), "hr": band("hr"),
        "rr": band("rr"), "temp": band("temp"), "spo2": band("spo2"),
    }
    # 수축기와 이완기를 따로 뽑으므로 맥압이 비현실적으로 좁아질 수 있다.
    # 밴드 안에서 이완기를 낮춰 최소 맥압을 확보한다.
    MIN_PP = 20
    if out["sbp"] - out["dbp"] < MIN_PP:
        target = out["sbp"] - MIN_PP
        out["dbp"] = max(target - (target % 2), int(v["dbp"][0]))

    if "armDiff" in v:
        lo, hi = v["armDiff"]
        out["armDiff"] = random.randint(int(lo), int(hi))

    # 변주 슬롯이 vitalsShift 를 들고 있으면 활력징후를 함께 움직인다.
    # 예: 자궁외임신에서 어깨끝 통증이 뽑히면 출혈이 더 진행한 것이므로
    # 혈압이 내려가고 맥박이 올라야 한다. 밴드 밖으로는 나가지 않는다.
    shifts = []
    for key, val in (slots or {}).items():
        if isinstance(val, dict) and val.get("vitalsShift"):
            shifts.append((key, val["vitalsShift"]))
    # 밴드는 기본 상태를 뜻한다. 이동은 그 밖으로 나갈 수 있어야 두 상태가 갈린다.
    # 다만 무한정 나가면 다른 진단이 되므로 shiftBounds 로 안전선을 둔다.
    bounds = v.get("shiftBounds") or {}
    for key, sh in shifts:
        for field, delta in sh.items():
            if field not in out or field == "invariant":
                continue
            lo, hi = bounds.get(field, v.get(field, [out[field], out[field]]))
            moved = out[field] + delta
            moved = max(min(moved, hi), lo)
            out[field] = round(moved, 1) if field == "temp" else int(moved)
        out.setdefault("_shiftedBy", []).append(key)

    out["invariant"] = v.get("invariant", "")
    return out


def resolve_findings(scenario, slots):
    """확률적 소견({p, detected, notDetected})을 세션 시작 때 한 번 뽑아 고정한다.
    한 세션 안에서는 다시 물어도 같은 답이 나와야 하므로 여기서 확정한다."""
    out, rolled = {}, []
    for key, val in ((scenario.get("pe") or {}).get("findings") or {}).items():
        if isinstance(val, dict) and "p" in val:
            hit = random.random() < float(val["p"])
            out[key] = fill(val["detected"] if hit else val["notDetected"], slots)
            rolled.append((key, hit, float(val["p"])))
        else:
            out[key] = fill(val, slots)
    return out, rolled


JOSA_PAIRS = {"이": ("이", "가"), "가": ("이", "가"), "은": ("은", "는"), "는": ("은", "는"),
              "을": ("을", "를"), "를": ("을", "를"), "과": ("과", "와"), "와": ("과", "와"),
              # 서술격조사도 받침에 따라 갈린다. "하이드로클로로티아지드이라고" 가 됐다.
              "이라고": ("이라고", "라고"), "라고": ("이라고", "라고"),
              "이면": ("이면", "면"), "면": ("이면", "면")}
# 조사 뒤에 한글이 이어지면 그것은 조사가 아니라 낱말의 일부다. 이 구분이 없어서
# "{{lmp}}이고" 의 "이" 를 조사로 보고 "…이었어요가고" 로 바꿔 놓았다.
# 조사 자리가 안 맞으면 아예 안 잡히도록 선택 그룹 안에 붙인다 — 밖에 두면
# 슬롯 자체가 치환되지 않는다.
SLOT_RE = re.compile(
    r"\{\{(\w+)\}\}(?:(이라고|라고|이면|면|으로|로|이|가|은|는|을|를|과|와)(?![가-힣]))?")


def has_batchim(word):
    """마지막 글자에 받침이 있는가. 없으면 None."""
    for ch in reversed(word or ""):
        if "가" <= ch <= "힣":
            return (ord(ch) - 0xAC00) % 28 != 0
        if ch.isdigit():
            return ch not in "2459"   # 이·사·오·구 는 받침이 없다
        if ch.isalpha():
            return False
    return None


def fill(text, slots):
    """{{슬롯}} 을 치환한다. 값이 dict 면 text 키를 쓴다.
    치환한 값의 받침에 맞춰 뒤따르는 조사를 고친다. 안 고치면
    "남편가 줄이라고 해요" 처럼 조사가 깨진다."""
    if not isinstance(text, str):
        return text

    def one(m):
        key, josa = m.group(1), m.group(2)
        if key not in slots:
            return m.group(0)
        val = slots[key]
        if isinstance(val, dict):
            val = val.get("text", "")
        val = str(val)
        if not josa:
            return val
        bat = has_batchim(val)
        if bat is None:
            return val + josa
        if josa in ("으로", "로"):
            # 받침이 ㄹ 이면 "로" 를 쓴다
            last = val[-1] if val else ""
            rieul = "가" <= last <= "힣" and (ord(last) - 0xAC00) % 28 == 8
            return val + ("으로" if (bat and not rieul) else "로")
        a, b = JOSA_PAIRS[josa]
        return val + (a if bat else b)

    prev = None
    while prev != text:                 # 값 안에 또 슬롯이 있는 경우까지
        prev = text
        text = SLOT_RE.sub(one, text)
    return natural_durations(text)


# "18개월 전", "24시간 전" 은 사람이 하는 말이 아니다 — 환자가 그대로 읽어 말투가 딱딱해졌다.
# 시점·기간을 말하는 "… 전/째/사이" 만 바꾼다. "생후 18개월", "16개월에 걸었다" 같은 나이는 그대로 둔다.
# src/sampleCase.js 의 naturalDurations 와 같은 규칙이다.
HOUR_WORDS = {24: "하루", 36: "하루 반", 48: "이틀", 72: "사흘"}
DAY_WORDS = {7: "일주일", 14: "2주", 21: "3주", 28: "4주"}


def natural_durations(text):
    def months(m):
        v = int(m.group(1))
        if v < 12:
            return m.group(0)
        y, r = divmod(v, 12)
        return f"{y}년" if r == 0 else f"{y}년 반" if r == 6 else f"{y}년 {r}개월"

    text = re.sub(r"(?<!\d)(\d+)\s*개월(?=\s*(쯤\s*)?(전|째|사이))", months, text)
    text = re.sub(r"(?<!\d)(\d+)\s*시간(?=\s*(쯤\s*)?(전|째))",
                  lambda m: HOUR_WORDS.get(int(m.group(1)), m.group(0)), text)
    return re.sub(r"(?<!\d)(\d+)\s*일(?=\s*(쯤\s*)?(전|째))",
                  lambda m: DAY_WORDS.get(int(m.group(1)), m.group(0)), text)


def fill_deep(node, slots):
    if isinstance(node, dict):
        return dict((k, fill_deep(v, slots)) for k, v in node.items())
    if isinstance(node, list):
        return [fill_deep(x, slots) for x in node]
    return fill(node, slots)


# ---------------------------------------------------------------- 조립

def build(topic, data, scenario_id=None):
    personas = load(os.path.join(CASES, "personas.json"))
    pool = data["scenarios"]
    scenario = next((s for s in pool if s["id"] == scenario_id), None) if scenario_id else None
    if scenario is None:
        scenario = random.choice(pool)

    person = draw_person(scenario, personas)
    slots = draw_slots(scenario, person)
    # 상황문의 {{age}}·{{sexText}} 가 따로 뽑히면 "62세 여성"이라 써놓고 인물은 64세가 된다.
    # 인물 값으로 덮어써서 한 케이스 안에서 나이·성별이 하나만 존재하게 한다.
    if "age" in slots:
        slots["age"] = person["age"]
    if "sexText" in slots:
        slots["sexText"] = "남성" if person["sex"] == "male" else "여성"

    # 카드가 흡연·음주 문구를 직접 지정했다면 그 안의 슬롯도 치환한다.
    # 슬롯은 인물을 뽑은 뒤에야 정해지므로 여기서 한다.
    for key in ("smoking", "alcohol"):
        if person[key].get("id") == "card":
            person[key] = dict(person[key], label=fill(person[key]["label"], slots))

    person["slots"] = slots
    guardian = draw_guardian(scenario, person, personas, slots)
    if guardian:
        person["guardian"] = guardian
        # 의식장애처럼 나이와 상관없이 본인이 답할 수 없는 카드는 informant.speaksForSelf: false 로 막는다.
        info = scenario.get("informant")
        blocked = isinstance(info, dict) and info.get("speaksForSelf") is False
        person["speaksForSelf"] = person["age"] >= 13 and not blocked
    # 본인이 답하지 못하는 아이의 ICE 를 아이 것으로 두면, 다섯 살의 생각이
    # "약만 좀 지어주면 될 것 같다" 가 된다. 그 생각은 데려온 보호자의 것이다.
    person["iceOwner"] = "보호자" if (guardian and not person.get("speaksForSelf")) else "환자"

    problems = []
    validate(person, scenario, personas, problems)

    # 시나리오에 ICE(생각·걱정·기대)가 따로 있으면 인물 성향의 한 줄 ICE 대신 그것을 쓴다.
    # 성향 ICE 는 케이스와 무관한 한 문장이라 "가장 걱정되는 게?"에 어느 케이스든 같은 답이 나왔다.
    # 검증은 성향 ICE 로 끝낸 뒤에 바꾼다 — 상충 조합 규칙이 성향 id 를 보기 때문.
    s_ice = scenario_ice(scenario, person)
    if s_ice:
        person["ice"] = s_ice
    # "ice": false — 심정지처럼 환자가 말할 수 없는 카드. 성향 ICE("별거 아닐 것 같은데
    # 주변에서 가보라고 해서 왔다")가 쓰러진 환자에게 붙어 있었다.
    if scenario.get("ice") is False:
        person["ice"] = {"id": "none", "idea": "해당 없음 (환자가 의식이 없거나 말할 수 없는 상황이라 생각·걱정·기대를 말하지 않는다)"}

    findings, rolled = resolve_findings(scenario, slots)
    return {
        "topic": data["topic"], "topicFile": topic,
        "scenario": scenario, "person": person,
        "slots": slots, "vitals": draw_vitals(scenario, person, slots),
        "findings": findings, "rolled": rolled,
        "problems": problems,
    }


# ---------------------------------------------------------------- 출력

def render(case):
    s, p = case["scenario"], case["person"]
    slots = case["slots"]
    L = []
    L.append("[%s] %s — %s" % (case["topicFile"], case["topic"], s["dx"]))
    L.append("")
    L.append("환자   %s · %d세 · %s · %s" % (
        p["name"], p["age"], "남" if p["sex"] == "male" else "여", p["occupation"]["label"]))
    L.append("성격   %s / 건강정보 %s" % (p["personality"]["label"], p["healthLiteracy"]["label"]))
    L.append("       %s" % p["personality"]["voice"])
    if p.get("guardian"):
        g = p["guardian"]
        occ = g["occupation"]["label"] if g["occupation"] else "-"
        role = g["role"]
        rel = role.get("relation") if isinstance(role, dict) else role
        L.append("보호자 %d세 · %s · %s   (%s)" % (
            g["age"], "여" if g["sex"] == "female" else "남", occ, rel or "동반 보호자"))
        L.append("       환자 본인 응답 %s" % ("가능" if p.get("speaksForSelf") else "불가 — 보호자가 대신 답한다"))
    L.append("ICE    (%s) %s" % (p.get("iceOwner", "환자"), p["ice"]["idea"]))
    # 아이에게 흡연·음주 칸을 붙이지 않는다
    habits = "" if p["age"] < ADULT_AGE else " · 흡연 %s · 음주 %s" % (
        p["smoking"]["label"], p["alcohol"]["label"])
    L.append("배경   %s%s%s" % (
        p["illness"]["label"], habits,
        ("  (필수 위험인자: %s)" % ", ".join(p["forcedRisk"])) if p["forcedRisk"] else ""))
    L.append("")
    L.append("첫 대사  %s" % fill(random.choice(s["opening"]), slots))
    L.append("")
    hpi = fill_deep(s["hpi"], slots)
    for k in ("onset", "character", "location", "radiation",
              "aggravating", "relieving", "severity", "course"):
        if hpi.get(k):
            L.append("  %-11s %s" % (k, hpi[k]))
    L.append("")
    v = case["vitals"]
    if "sbp" in v:
        line = "활력   %s/%s · 맥박 %s · 호흡 %s · 체온 %s · SpO2 %s" % (
            v["sbp"], v["dbp"], v["hr"], v["rr"], v["temp"], v["spo2"])
        if "armDiff" in v:
            line += " · 양팔차 %s" % v["armDiff"]
        L.append(line)
    L.append("")
    if case.get("rolled"):
        L.append("확률 소견")
        for key, hit, p in case["rolled"]:
            L.append("  %-16s %s (p=%.1f)  %s" % (
                key, "잡힘" if hit else "안 잡힘", p, case["findings"][key]))
        L.append("")
    L.append("먼저 말함    %s" % ", ".join(s["disclosure"]["spontaneous"]))
    L.append("물어야 나옴  %s" % ", ".join(fill_deep(s["disclosure"]["onlyIfAsked"], slots)))
    if case["problems"]:
        L.append("")
        L.append("규칙 위반")
        for x in case["problems"]:
            L.append("  - %s" % x)
    return "\n".join(L)


def check(n):
    files = topic_files()
    if not files:
        print("케이스 파일이 없습니다: %s" % CASES)
        return 1
    counts, total = {}, 0
    for _ in range(n):
        topic, data = random.choice(files)
        case = build(topic, data)
        total += 1
        for prob in case["problems"]:
            key = prob.split(":")[0]
            counts.setdefault(key, []).append("%s/%s · %s" % (topic, case["scenario"]["id"], prob))

    print("표본 %d회 · 카드 %d개 · 시나리오 %d개"
          % (total, len(files), sum(len(d["scenarios"]) for _, d in files)))
    if not counts:
        print("규칙 위반 0건")
        return 0
    print("규칙 위반 %d건" % sum(len(v) for v in counts.values()))
    for key in sorted(counts, key=lambda k: -len(counts[k])):
        rows = counts[key]
        print("\n  %s — %d건" % (key, len(rows)))
        for r in sorted(set(rows))[:5]:
            print("    %s" % r)
        if len(set(rows)) > 5:
            print("    ... 그 외 %d종" % (len(set(rows)) - 5))
    return 1


def as_json(case):
    """스킬이 그대로 읽을 수 있는 형태로 조합 결과를 펼친다.
    변주는 이미 치환돼 있고 확률 소견도 확정돼 있다."""
    s, p, slots = case["scenario"], case["person"], case["slots"]
    filled = fill_deep({k: v for k, v in s.items()
                        if k not in ("pe", "variations", "constraints", "occupationBias", "iceHint", "ice")},
                       slots)
    person = {
        "name": p["name"], "age": p["age"],
        "sex": "남" if p["sex"] == "male" else "여",
        "occupation": p["occupation"]["label"],
        "personality": p["personality"]["label"],
        "personalityVoice": p["personality"]["voice"],
        "healthLiteracy": p["healthLiteracy"]["label"],
        "healthLiteracyVoice": p["healthLiteracy"]["voice"],
        "ice": p["ice"]["idea"],
        # 아이가 스스로 답하지 못하면 그 생각은 보호자의 것이다
        "iceOwner": p.get("iceOwner", "환자"),
        "backgroundIllness": p["illness"]["label"],
        "smoking": p["smoking"]["label"],
        "alcohol": p["alcohol"]["label"],
        "forcedRisk": p.get("forcedRisk") or [],
    }
    if p.get("guardian"):
        g = p["guardian"]
        person["guardian"] = {
            "age": g["age"], "sex": "여" if g["sex"] == "female" else "남",
            "occupation": (g["occupation"] or {}).get("label", "-"),
            # 보호자의 성격·건강정보를 빼면 따로 뽑은 의미가 없다.
            # 스킬은 이 값으로 보호자를 환자와 다른 사람으로 연기한다.
            "personality": g["personality"]["label"],
            "personalityVoice": g["personality"]["voice"],
            "healthLiteracy": g["healthLiteracy"]["label"],
            "healthLiteracyVoice": g["healthLiteracy"]["voice"],
            "role": g["role"],
        }
        if g.get("voiceWins"):
            person["guardian"]["voiceWins"] = True
        person["speaksForSelf"] = p.get("speaksForSelf", True)

    # 케이스 카드의 pmh 는 진단과 관련된 병력, 인물 카드의 배경질환은 그와 무관한 지병이다.
    # 따로 두면 "특이 병력 없음"과 "고혈압 보유"가 동시에 참이 되어 학생이 물었을 때 답이 갈린다.
    card_pmh = fill(s.get("pmh") or "", slots)
    # 카드 작성자가 모델에게 남긴 지시문은 답변에서 뺀다. 그대로 읽으면 학생에게 노출된다.
    card_pmh = strip_directives(card_pmh)
    illness = p["illness"]["label"]
    parts = []

    # 배경질환이 있는데 카드가 "없음"이면 그 말은 버린다.
    # 붙이면 "고혈압. 특이사항 없음" 이 되어 무엇이 없다는 건지 알 수 없다.
    # 다만 통째로 버리면 안 된다 — "특이 병력 없음. 위내시경은 2년 전에 받았고 위염
    # 소견만 들음" 처럼 앞 문장만 "없음" 인 카드가 28개라, 뒤 문장이 통째로 사라져
    # 물어도 안 나오는 정보가 됐다. 약물 칸과 같이 문장 단위로 뗀다.
    segs = [x.strip() for x in re.split(r"(?<=[.。])\s+", card_pmh) if x.strip()]
    kept = [x for x in segs if not NONE_PMH_RE.match(x.rstrip(".。"))]

    # 카드가 이미 그 병을 말하고 있으면 앞에 또 붙이지 않는다
    if illness and illness != "없음" and illness not in card_pmh:
        parts.append(illness)
    if card_pmh:
        if not parts:
            parts.append(card_pmh)
        elif kept:
            parts.append(" ".join(kept))
    person["pmhResolved"] = ". ".join(parts) if parts else "특이 병력 없음"
    # 보호자가 말하는 카드는 pmh·meds 가 "환자(어머니)는 …" 처럼 제3자 이야기다. 인물의
    # 배경질환을 그 앞에 그냥 붙이면 "당뇨병. 환자(어머니)는 위암…" 이 되어 누구 병인지 갈렸다.
    if card_pmh.startswith("환자"):
        own = illness if illness and illness != "없음" else "특이 병력 없음"
        person["pmhResolved"] = "보호자 본인 %s. %s" % (own, card_pmh)

    meds_card = strip_directives(fill(s.get("meds") or "", slots))
    med_list = [m for m in (p["illness"].get("meds") or [])]
    # 사회력도 같은 문제가 있다. 카드의 sh 에는 "인물 카드를 따르되 ..." 같은 지시문이 섞여 있어
    # 그대로 읽으면 학생에게 지시문이 노출된다. 지시문을 떼고 인물의 값과 합친다.
    sh_card = strip_directives(fill(s.get("sh") or "", slots))
    # 아이에게 흡연·음주 칸을 붙이면 안 된다. 한 살 아기의 사회력에
    # "흡연 비흡연 · 음주 안 마심" 이 붙어 있었다.
    if p["age"] < ADULT_AGE:
        sh_base = "직업 %s" % p["occupation"]["label"]
    else:
        sh_base = "직업 %s · 흡연 %s · 음주 %s" % (
            p["occupation"]["label"], p["smoking"]["label"], p["alcohol"]["label"])
    person["shResolved"] = (sh_base + (". " + sh_card if sh_card else "")).strip()

    # 인물의 약과 카드의 약을 합친다. 다만 카드가 "없음"이라고만 적혀 있으면
    # 인물의 약 뒤에 붙이지 않는다. "에스시탈로프람. 없음" 이 되어 버린다.
    # 목록으로 두면 "따로 새로 먹기 시작한 약은 없어요" 같은 새 표현이 늘 빠져나가
    # "암로디핀. 약은 안 먹어요." 가 된다. 문장 꼴로 알아본다.
    # "복용 중인 약 없음. 소염진통제도 자주 먹지는 않음" 처럼 앞 문장만 "없음"이고
    # 뒤에 내용이 더 있는 카드가 있다. 문장 단위로 떼어야 뒤 내용을 잃지 않는다.
    kept = [x for x in re.split(r"(?<=[.。])\s+|\.\s*$", meds_card) if x and x.strip()]
    kept = [x for x in kept if not NONE_MEDS_RE.match(x.strip())]
    card_is_none = bool(NONE_MEDS_RE.match(meds_card.strip())) or not kept
    # 카드가 그 병의 약을 이미 다루고 있으면 배경약을 앞에 또 붙이지 않는다.
    # ACE억제제 기침 카드가 "암로디핀. 혈압약을 다른 것으로 바꿈" 이 되어
    # 무엇을 먹는 중인지 알 수 없었다.
    if s.get("_ownMeds"):
        person["medsResolved"] = " ".join(kept) or meds_card
        med_list = []
    if med_list and card_is_none:
        person["medsResolved"] = ", ".join(med_list)
    elif med_list and meds_card:
        person["medsResolved"] = ", ".join(med_list) + ". " + " ".join(kept)
    else:
        person["medsResolved"] = (", ".join(med_list) or meds_card).strip() or "복용 약 없음"
    if meds_card.startswith("환자"):
        own = ", ".join(p["illness"].get("meds") or []) or "복용 약 없음"
        person["medsResolved"] = "보호자 본인 %s. %s" % (own, meds_card)

    pe = dict(s.get("pe") or {})
    pe.pop("vitals", None)
    pe.pop("findings", None)
    pe = fill_deep(pe, slots)
    if case["vitals"].get("_raw") is None and "sbp" not in case["vitals"]:
        pe.pop("vitals", None)          # 술기 카드는 활력징후 밴드가 없다
    else:
        pe["vitals"] = case["vitals"]
    if case["findings"]:
        pe["findings"] = case["findings"]

    # 원본 칸에는 "인물 카드를 따르되 ..." 같은 지시문이 남아 있다. 스킬이 그것을 읽지 않도록
    # 통합본으로 갈아끼운다. 답이 하나만 남아야 학생에게 지시문이 새지 않는다.
    for key, resolved in (("pmh", "pmhResolved"), ("meds", "medsResolved"), ("sh", "shResolved")):
        if resolved in person:
            filled[key] = person[resolved]

    return {
        "topic": case["topic"], "topicFile": case["topicFile"],
        "scenarioId": s["id"], "dx": s.get("dx") or s.get("situation"),
        "person": person, "scenario": filled, "pe": pe,
        "rolledProbabilistic": [
            {"finding": k, "detected": hit, "p": pr} for k, hit, pr in case.get("rolled", [])],
        "problems": case["problems"],
    }


def main(argv):
    if argv and argv[0] == "--check":
        return check(int(argv[1]) if len(argv) > 1 else 1000)

    want_json = "--json" in argv
    argv = [a for a in argv if a != "--json"]

    files = topic_files()
    if not files:
        print("케이스 파일이 없습니다: %s" % CASES)
        return 1
    if argv:
        want = argv[0]
        match = [(t, d) for t, d in files if t == want or t.startswith(want)]
        if not match:
            print("그런 주호소 파일이 없습니다: %s" % want)
            print("가능한 값: %s" % ", ".join(t for t, _ in files))
            return 1
        topic, data = match[0]
    else:
        # 기본진료술기(응급처치·상처 관리·채혈)는 문진 케이스가 아니라 절차 수행형이라
        # 무작위 풀에서 뺀다. 이름을 직접 지정했을 때만(위 분기) 나온다.
        pool = [(t, d) for t, d in files if not d.get("_procedureCase")]
        topic, data = random.choice(pool or files)

    case = build(topic, data, argv[1] if len(argv) > 1 else None)
    if want_json:
        print(json.dumps(as_json(case), ensure_ascii=False, indent=2))
    else:
        print(render(case))
    return 1 if case["problems"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

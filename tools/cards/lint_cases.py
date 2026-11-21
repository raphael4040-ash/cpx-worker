# -*- coding: utf-8 -*-
"""케이스 카드 스키마 린터

카드가 채점표(checklist.md)를 채울 수 있는 형태인지 기계적으로 검사한다.
임상적 타당성은 사람이 봐야 하지만, 필드 누락과 형식 어긋남은 여기서 잡는다.

    python lint_cases.py            전체 검사
    python lint_cases.py 21         파일명이 21 로 시작하는 것만
"""
from __future__ import unicode_literals
import io, json, os, re, sys, glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.normpath(os.path.join(HERE, "..", "..", "src", "cases"))

# 생성기가 사람에게서 바로 채우는 슬롯. 카드의 variations 에 없어도 된다.
AUTO_SLOTS = {"smoking", "alcohol", "olderBro", "olderSis", "spouse", "inlaws",
              "alcoholSay", "alcoholSayHon", "smokingSay"}

TOP_REQUIRED = ["topicId", "topic", "scenarios"]
SC_REQUIRED = ["id", "dx", "constraints", "opening", "hpi", "assoc",
               "redFlags", "pmh", "meds", "allergy", "fh", "sh",
               "variations", "disclosure"]
HPI_REQUIRED = ["onset", "character", "aggravating", "relieving", "severity", "course"]
VITAL_KEYS = ["sbp", "dbp", "hr", "rr", "temp", "spo2"]

# 상담·술기 카드는 신체진찰이 없거나 구조가 다르다. 이 표식이 있으면 pe 검사를 건너뛴다.
EXEMPT_FLAGS = ["_noPhysicalExam", "_procedureCase"]


def load(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


PERSONAS = load(os.path.join(CASES, "personas.json"))


def slots_walk(node, out):
    """카드 안의 모든 문자열을 모은다. 문답 질문은 키에 들어 있으므로 키도 본다."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(k, str):
                out.append(k)
            slots_walk(v, out)
    elif isinstance(node, list):
        for v in node:
            slots_walk(v, out)
    elif isinstance(node, str):
        out.append(node)
    return out


def keys_with_slots(node, out):
    """dict 키 안에 {{슬롯}} 이 들어 있는지 모은다. fill_deep 은 값만 치환하고
    키는 건드리지 않으므로, 소견 칸 이름에 슬롯을 넣으면 "유방 촉진({{side}}쪽)"
    처럼 학생에게 그대로 노출된다 (34-1 유방통에서 실제로 났다)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(k, str) and "{{" in k:
                out.append(k)
            keys_with_slots(v, out)
    elif isinstance(node, list):
        for v in node:
            keys_with_slots(v, out)
    return out


def slots_used(node, out):
    if isinstance(node, dict):
        for v in node.values():
            slots_used(v, out)
    elif isinstance(node, list):
        for v in node:
            slots_used(v, out)
    elif isinstance(node, str):
        out.update(re.findall(r"\{\{(\w+)\}\}", node))
    return out


# 동반증상 "양성" 목록에 쓰인 슬롯이 부정 답변도 뽑으면, "필름 끊긴 적은 없어요" 가
# 증상으로 나열된다. 한 슬롯을 red flag 답변과 양성 목록에 함께 쓸 때 생긴다
# (08-근력/감각에서 27곳을 고쳤고 16-허리통증·35-음주상담에 3곳이 남아 있었다).
DENIAL = re.compile(r"(적은 없|적 없|없어요|없습니다|않아요|않은 것|아니에요|아닙니다)")

# 병력 칸에 남은 저자의 미결정. "고혈압 경계 또는 진단", "만성질환 가능" 은 카드를
# 쓰는 사람의 메모지 환자가 할 수 있는 말이 아니고, 실제로 배경질환과 어긋났다
# (16-허리통증에서 배경질환이 없는데도 "만성질환 약" 을 먹는 환자가 26% 나왔다).
INDETERMINATE = re.compile(r"(가능\s*(?:[.。]|$)|경계 또는|또는 진단)")
NOTE_FIELDS = ["pmh", "meds", "allergy", "fh"]

# 사회력 칸에 남은 연기 지시. "비판단적으로 물으면 실제 양을 말한다" 는 환자가 할 말이
# 아니라 모델에게 거는 지시인데, sh 에 적으면 사회력 답변에 그대로 실려 나간다
# (17-물질오남용 5개 시나리오 전부가 그랬다). `_spBehavior` 로 옮겨야 한다.
BEHAVIOR_NOTE = re.compile(r"(방어적|비판단적|훈계|머뭇거리)")

# 카드가 흡연·음주를 sh 에 문장으로만 적어 두면 인물 값과 어긋난다. 실제로 임신부가
# "금연·금주"라고 적힌 카드에서 하루 한 갑 흡연·주 3~4회 폭음으로 나왔다.
# 단정적으로 적은 것("비흡연·비음주", "금연", "금주")만 잡는다 — constraints 로 옮길 것.
ABSOLUTE_HABIT = re.compile(r"(금연|금주|비흡연|비음주|술[·,]|담배는 전혀|술은 전혀)")
HABIT_KEYS = ("smoking", "alcohol", "smokingLabel", "alcoholLabel")

# 첫 대사가 기간을 못 박아 두었는데 발병은 슬롯인 곳. "이틀째 열이 나는데" 인데
# onsetDays 가 [2, 3] 이면 세 번 중 한 번은 어긋난다(11-기침 통독에서 3곳을 고쳤는데
# 그때 검출이 좁아 14곳이 남아 있었다). 첫 대사만 본다 — 경과(course)의 "최근 한 달
# 사이" 같은 표현은 전체 기간이 아니라 그 안의 구간이라 오탐이 난다.
DURATION_WORDS = {"어제": 1, "이틀": 2, "사흘": 3, "나흘": 4,
                  "일주일": 7, "한 달": 1, "두 달": 2, "석 달": 3}

# 과거력 칸이 문답 답변을 그대로 받아 "그런 적은 없어요." 만 남는 경우.
# 문답에서는 질문이 가리키는 대상을 주지만 과거력 칸에는 질문이 없어서
# 무엇이 없다는 건지 알 수 없다. 가족력의 "가족 중에 그런 병은 없어요" 처럼
# 앞에 대상을 밝히는 말이 있는 것은 이 카드 세트의 방식이라 건드리지 않는다.
DEMONSTRATIVE_PMH = re.compile(r"^(그런|그건|그렇)")

# 저자가 붙인 라벨. "대장내시경 검사력 — 10년 전에 받고는 안 했어요" 처럼 적으면
# 환자가 라벨까지 읽는다. hpi 의 "해당 없음 — 통증은 없음" 은 학생에게 답으로
# 나가지 않는 칸이라 병력 계열 칸에만 건다.
AUTHOR_LABEL = re.compile(r"\s[—–]\s")

# 변주 값이 "해당 없음(남성)" 이면 red flag 답변 자리에서 환자가 그대로 읽는다.
# 남성 환자도 "저는 남자라서 해당이 없어요" 처럼 연기할 수 있는 말이어야 한다.
NOT_APPLICABLE = re.compile(r"^해당 없음")

# 동반증상·문답에 남은 저자의 미결정. "야간에 깨서 화장실 가는 일은 없음(또는 있음)" 은
# 표준화환자가 연기할 수 없다 — 있다는 건지 없다는 건지 골라 적어야 한다.
HEDGE = re.compile(r"\(또는|또는 있음|또는 없음")

# 슬롯이 한글 낱말 한가운데에 박힌 경우. 1.3.19 에서 "처가" 를 {{inlaws}} 자동 슬롯으로
# 옮길 때 낱말 안의 "처가" 까지 함께 치환돼 "상처가" 가 "상{{inlaws}}" 가 됐고, 여성
# 환자에게 "상시댁 없다", "몸에 곪은 데나 상시댁 있나" 로 나왔다(8개 파일 11곳).
# 정상적인 슬롯은 앞에 공백이나 문장 시작이 온다.
# 진찰 소견 칸 이름에 성별을 적어 둔 것. 카드가 남녀를 다 받는데 소견 내용이
# 한쪽 성별에만 맞으면 반대 성별 환자에게 그대로 나온다 — 여성 환자에게
# "직장 수지검사(남성) — 전립선이 매끈하게 약간 커져 있고" 가 나왔다(4곳).
# 소견 칸 이름에서 성별 표시를 떼고 값을 sexOnly 변주로 갈라야 한다.
# 계측 소견에 백분위를 못 박아 놓고 나이는 여러 해로 열어 둔 것. 같은 백분위라도
# 키는 한 살에 5~6 cm 씩 달라지므로 나이가 넓으면 표기와 수치가 어긋난다 —
# 9세 아이가 108 cm 인데 "3 백분위수" 로 나왔다(25-1·25-2 열 시나리오 전부).
# 계측값이 슬롯이면 나이를 한 살로 못 박아야 한다.
PERCENTILE_FINDING = re.compile(r"백분위")

SEXED_FINDING = re.compile(r"\((?:남성|여성)\)")

# 소견 칸 이름 자체가 한쪽 성별의 해부 구조만 가리키는 것. "(남성)" 표시가 없어도
# "외음부"·"음경" 처럼 이름만으로 이미 한쪽 성별 전용이면 반대 성별 환자에게
# 그대로 나온다 — 남성 환자에게 "외음부 — 칸디다 감염을 시사하는 발적" 이 나왔다
# (26-1). 양쪽을 다 적은 "외음부·고환 진찰" 같은 중립 이름은 대상이 아니다.
SEXED_ANATOMY_FEMALE = re.compile(r"외음부|질(?:경|진찰)?\b|자궁|난소")
SEXED_ANATOMY_MALE = re.compile(r"음경|고환|전립선|음낭")

# 고정 문장에 "남자애는 원래 늦다" 같은 성별 전제가 박혀 있는 것. 카드는
# sex: any 로 남녀를 다 받는데 문장은 한쪽 성별에만 말이 되면 반대 성별
# 환자에게 그대로 나온다 — 여자 아이인데 보호자가 "남자애라 늦는 것 같다"고
# 축소해 말했다(25-2, 2곳). variations 안에서 sexOnly 로 이미 갈라둔 값은
# 대상이 아니므로 그 블록은 보지 않는다.
GENDERED_ASSUMPTION = re.compile(r"남자애|여자애|아들이라|딸이라|아들이니까|딸이니까")

GLUED_SLOT = re.compile(r"[가-힣]\{\{\w+\}\}")


def walk_fixed_text(node, out):
    """variations 블록을 뺀 나머지 문자열만 모은다. sexOnly 로 이미 가른
    값은 variations 안에 있으므로 여기 걸리지 않는다."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "variations":
                continue
            walk_fixed_text(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_fixed_text(v, out)
    elif isinstance(node, str):
        out.append(node)
    return out


def duration_value(word, key):
    """그 낱말이 뜻하는 수를 슬롯의 단위로 바꾼다. 단위가 안 맞으면 None."""
    months = word in ("한 달", "두 달", "석 달")
    if key == "onsetDays":
        return None if months else DURATION_WORDS[word]
    if key == "onsetWeeks":
        return {"일주일": 1, "한 달": 4, "두 달": 9, "석 달": 13}.get(word)
    if key == "onsetMonths":
        return DURATION_WORDS[word] if months else None
    return None


# invariant 문장이 무엇을 요구하는지 가른다. "빈맥이 생기면 …" 같은 조건절은 요구가 아니다.
INV_REQUIRE = ("유지", "이어야", "있어야", "반드시")
INV_NEGATE = ("없", "않", "넣지", "금지", "안 된다", "쓰지", "내리지",
              "생기면", "나오면", "되면", "사라지면", "나타나면", "뚜렷하면", "이면")


def check_file(path):
    name = os.path.basename(path)
    errs, warns = [], []
    try:
        d = load(path)
    except Exception as e:
        return name, ["JSON 파싱 실패: %s" % e], []

    for k in TOP_REQUIRED:
        if k not in d:
            errs.append("최상위 필드 누락: %s" % k)
    if not d.get("scenarios"):
        return name, errs + ["시나리오가 없음"], warns

    exempt = any(d.get(f) for f in EXEMPT_FLAGS)
    if not exempt and "_peRules" not in d:
        warns.append("_peRules 없음")

    ids = set()
    for i, s in enumerate(d["scenarios"]):
        tag = "%s#%d" % (s.get("id", "?"), i)

        if s.get("id") in ids:
            errs.append("%s: id 중복" % tag)
        ids.add(s.get("id"))

        for k in SC_REQUIRED:
            if k not in s:
                # 술기 카드는 dx 대신 situation 을 쓴다
                if k == "dx" and "situation" in s:
                    continue
                # 상담·술기 카드는 병력청취 구조 자체가 없다
                if exempt and k in ("hpi", "assoc", "redFlags", "pmh", "meds", "allergy", "fh", "sh"):
                    continue
                errs.append("%s: 필드 누락 %s" % (tag, k))

        c = s.get("constraints") or {}
        if "ageRange" not in c or len(c.get("ageRange", [])) != 2:
            errs.append("%s: constraints.ageRange 형식 오류" % tag)
        else:
            lo, hi = c["ageRange"]
            if lo > hi:
                errs.append("%s: ageRange 상하한 뒤바뀜" % tag)
            if lo < 0 or hi > 100:
                warns.append("%s: ageRange 가 이상함 (%s~%s)" % (tag, lo, hi))

            # 변주 값이 전부 minAge/maxAge 로만 걸려 있는데 ageRange 의 젊은(또는 나이 든)
            # 쪽 끝에서 후보가 하나도 안 남으면, draw_slots 가 빈 문자열로 떨어뜨린다.
            # 35-2 금연상담 준비단계 카드에서 32~33세가 "{{years}}" 없이 "하루 1갑, 년이요."
            # 로 나온 것이 이 유형이었다 — ageRange 는 32부터인데 년수 슬롯의 최저 minAge 가 34였다.
            for vkey, pool in (s.get("variations") or {}).items():
                if not isinstance(pool, list) or not pool:
                    continue
                if not all(isinstance(v, dict) for v in pool):
                    continue
                if any(("sexOnly" in v or "occOnly" in v) for v in pool):
                    continue  # 성별·직업 조합까지는 여기서 안 본다 — 오탐 위험이 크다
                gaps = [age for age in range(lo, hi + 1)
                        if not any((v.get("minAge") is None or age >= v["minAge"])
                                   and (v.get("maxAge") is None or age <= v["maxAge"])
                                   for v in pool)]
                if gaps:
                    errs.append("%s: variations.%s 가 나이 %s~%s 구간에서 후보가 없음 (ageRange 는 %s~%s) — 빈 문자열로 나온다"
                                % (tag, vkey, gaps[0], gaps[-1], lo, hi))
        # occupationOnly 는 직업을 못박는다. 없는 id 이거나 ageRange 안에서 하나도
        # 못 고르면 sample_case 가 조용히 무시하므로 여기서 잡는다.
        only = c.get("occupationOnly")
        if only:
            occs = {o["id"]: o for o in PERSONAS.get("occupations", [])}
            unknown = [o for o in only if o not in occs]
            if unknown:
                errs.append("%s: occupationOnly 에 없는 직업 id %s" % (tag, unknown))
            elif "ageRange" in c:
                lo, hi = c["ageRange"]
                gaps = [a for a in range(lo, hi + 1)
                        if not any(occs[o].get("ageRange", [0, 200])[0] <= a <= occs[o].get("ageRange", [0, 200])[1]
                                   for o in only)]
                if gaps:
                    errs.append("%s: occupationOnly 가 나이 %s~%s 에서 고를 직업이 없음" % (tag, gaps[0], gaps[-1]))
        if c.get("sex") not in ("any", "male", "female", None):
            errs.append("%s: constraints.sex 값 오류 (%s)" % (tag, c.get("sex")))
        if c.get("requiredRisk") and not c.get("requiredRiskMin"):
            warns.append("%s: requiredRisk 는 있는데 requiredRiskMin 이 0" % tag)

        # 상담·술기 카드는 병력청취 구조가 없으므로 아래 검사를 건너뛴다
        if not exempt:
            hpi = s.get("hpi") or {}
            for k in HPI_REQUIRED:
                if not hpi.get(k):
                    warns.append("%s: hpi.%s 비어 있음" % (tag, k))

            assoc = s.get("assoc") or {}
            if not assoc.get("positive"):
                warns.append("%s: assoc.positive 없음" % tag)
            if not assoc.get("negative"):
                warns.append("%s: assoc.negative 없음 — 음성 소견이 없으면 감별 문진이 채점되지 않는다" % tag)

            if len(s.get("redFlags") or {}) < 4:
                warns.append("%s: redFlags 가 4개 미만" % tag)

        # invariant 가 요구하는 것을 활력징후 밴드가 보장하는지 본다.
        # "빈맥을 유지한다" 면서 맥박 하한이 96이면 빈맥이 아닌 환자가 나온다.
        v = (s.get("pe") or {}).get("vitals")
        if isinstance(v, dict):
            for cl in re.split(r"[.。]", v.get("invariant", "")):
                if not (any(w in cl for w in INV_REQUIRE)
                        and not any(w in cl for w in INV_NEGATE)):
                    continue
                hr, temp, spo2 = v.get("hr"), v.get("temp"), v.get("spo2")
                if "빈맥" in cl and hr:
                    floor = 90 if "경한" in cl else 100
                    if hr[0] < floor:
                        errs.append("%s: 빈맥을 요구하는데 맥박 하한이 %s" % (tag, hr[0]))
                if "서맥" in cl and hr and hr[1] > 60:
                    errs.append("%s: 서맥을 요구하는데 맥박 상한이 %s" % (tag, hr[1]))
                if "미열" in cl and temp and temp[0] < 37.0:
                    errs.append("%s: 미열을 요구하는데 체온 하한이 %s" % (tag, temp[0]))
                if "저산소혈증" in cl and spo2:
                    m = re.search(r"\((\d+)\s*이하\)", cl)
                    cap = int(m.group(1)) if m else 94
                    if spo2[1] > cap:
                        errs.append("%s: 저산소혈증을 요구하는데 SpO2 상한이 %s" % (tag, spo2[1]))

        # 양성 증상 목록에 부정 답변이 섞여 들어가는지
        pos = " ".join(str(x) for x in ((s.get("assoc") or {}).get("positive") or []))
        for key in sorted(set(re.findall(r"\{\{(\w+)\}\}", pos))):
            for item in (s.get("variations") or {}).get(key) or []:
                text = item.get("text", "") if isinstance(item, dict) else str(item)
                if DENIAL.search(text):
                    errs.append("%s: 양성 증상 목록의 {{%s}} 가 부정 답변을 뽑는다 (%s)"
                                % (tag, key, text[:24]))
                    break

        # 사회력 칸에 연기 지시가 남았는지
        sh = s.get("sh")
        if isinstance(sh, str) and BEHAVIOR_NOTE.search(sh):
            errs.append("%s: sh 에 연기 지시가 남아 있음 — _spBehavior 로 옮길 것 (%s)"
                        % (tag, BEHAVIOR_NOTE.search(sh).group(1)))

        # 흡연·음주를 sh 에 단정적으로 적어 놓고 constraints 로 옮기지 않았는지
        if isinstance(sh, str) and ABSOLUTE_HABIT.search(sh) and not any(c.get(k) for k in HABIT_KEYS):
            errs.append("%s: sh 가 흡연·음주를 단정하는데 constraints 에 없음 — 인물 값과 어긋난다 (%s)"
                        % (tag, ABSOLUTE_HABIT.search(sh).group(1)))

        # 첫 대사가 기간을 못 박았는데 발병이 슬롯인지
        onset = str((s.get("hpi") or {}).get("onset") or "")
        for key in ("onsetDays", "onsetWeeks", "onsetMonths"):
            if "{{%s}}" % key not in onset:
                continue
            pool = (s.get("variations") or {}).get(key) or []
            for line in (s.get("opening") or []):
                line = str(line)
                for word in DURATION_WORDS:
                    at = line.find(word)
                    # "일주일 넘게" 는 슬롯이 그보다 커도 참이다.
                    # 발병 문장에 같은 낱말이 있으면 카드가 이미 맞춰 둔 것이다.
                    if at < 0 or "넘게" in line[at:at + len(word) + 6] or word in onset:
                        continue
                    want = duration_value(word, key)
                    if want is not None and [x for x in pool if x != want]:
                        errs.append("%s: 첫 대사가 \"%s\" 로 기간을 못 박았는데 %s 는 %s"
                                    % (tag, word, key, pool))

        # 과거력 칸이 지시대명사로 시작해 가리키는 대상을 잃었는지
        pmh_field = s.get("pmh")
        if isinstance(pmh_field, str):
            for item in ((s.get("variations") or {}).get(
                    (re.findall(r"^\{\{(\w+)\}\}$", pmh_field.strip()) or [""])[0]) or [pmh_field]):
                text = item.get("text", "") if isinstance(item, dict) else str(item)
                if DEMONSTRATIVE_PMH.match(text.strip()):
                    errs.append("%s: 과거력이 \"%s\" 로 시작해 무엇을 가리키는지 없음"
                                % (tag, text[:20]))

        # 계측 소견이 백분위를 못 박았는데 나이 폭이 한 해를 넘는지
        ar = c.get("ageRange") or []
        if len(ar) == 2 and ar[1] > ar[0]:
            for key, val in ((s.get("pe") or {}).get("findings") or {}).items():
                if (isinstance(val, str) and "{{" in val
                        and PERCENTILE_FINDING.search(val) and "계측" in str(key)):
                    errs.append("%s: 계측 소견이 백분위를 못 박았는데 나이가 %s~%s세다 — 나이를 한 살로 고정할 것 (%s)"
                                % (tag, ar[0], ar[1], key))
                    break

        # 진찰 소견 칸 이름이 성별을 못 박았는데 카드는 남녀를 다 받는지
        if (c.get("sex") or "any") == "any":
            for key in ((pe0 := (s.get("pe") or {})).get("findings") or {}):
                if SEXED_FINDING.search(str(key)):
                    errs.append("%s: 소견 칸 이름이 성별을 못 박음 (%s) — 값을 sexOnly 변주로 가를 것"
                                % (tag, key))

        # 소견 칸 이름 자체가 한쪽 성별의 해부 구조만 가리키는지 (표시가 없어도)
        if (c.get("sex") or "any") == "any":
            for key in ((s.get("pe") or {}).get("findings") or {}):
                ks = str(key)
                has_f = bool(SEXED_ANATOMY_FEMALE.search(ks))
                has_m = bool(SEXED_ANATOMY_MALE.search(ks))
                if has_f != has_m:  # 둘 다 있으면("외음부·고환") 중립 이름이라 대상 아님
                    errs.append("%s: 소견 칸 이름이 한쪽 성별 해부 구조만 가리킴 (%s) — 이름을 중립으로 바꾸고 값을 sexOnly 변주로 가를 것"
                                % (tag, key))

        # 고정 문장이 "남자애는 원래 늦다" 처럼 성별을 전제하는데 카드는 남녀를 다 받는지
        if (c.get("sex") or "any") == "any":
            fixed_texts = walk_fixed_text(
                {k: v for k, v in s.items() if k != "id" and k != "dx"}, [])
            for text in fixed_texts:
                m = GENDERED_ASSUMPTION.search(text)
                if m:
                    errs.append("%s: 고정 문장이 성별을 전제함 (…%s…) — {{슬롯}}으로 빼고 sexOnly 변주로 가를 것"
                                % (tag, text[max(0, m.start() - 6):m.end() + 6]))
                    break

        # 슬롯이 낱말 한가운데에 박혔는지
        glued = []
        slots_walk(s, glued)
        for text in glued:
            m = GLUED_SLOT.search(text)
            if m:
                errs.append("%s: 슬롯이 낱말 안에 박혀 있음 (…%s…)"
                            % (tag, text[max(0, m.start() - 6):m.end() + 4]))
                break

        # 소견 칸 이름 등 키에 슬롯이 들어 있는지 (fill_deep 은 값만 치환한다)
        bad_keys = keys_with_slots(s, [])
        for k in bad_keys:
            errs.append("%s: 칸 이름(키)에 {{슬롯}} 이 들어 있어 치환되지 않고 그대로 노출됨 (%s)"
                        % (tag, k))

        # 동반증상·문답에 저자의 미결정이 남았는지
        assoc = s.get("assoc") or {}
        for where, node in (("assoc.positive", assoc.get("positive") or []),
                            ("assoc.negative", assoc.get("negative") or []),
                            ("redFlags", list((s.get("redFlags") or {}).values()))):
            for item in node:
                if isinstance(item, str) and HEDGE.search(item):
                    errs.append("%s: %s 에 미결정 표기가 남아 있음 (%s)" % (tag, where, item[:30]))

        # 병력 계열 칸에 저자 라벨이 남았는지
        for f in NOTE_FIELDS + ["sh"]:
            val = s.get(f)
            if isinstance(val, str) and AUTHOR_LABEL.search(val):
                errs.append("%s: %s 에 저자 라벨이 남아 있음 (%s)" % (tag, f, val[:30]))

        # 변주 값이 환자가 연기할 수 없는 "해당 없음(…)" 인지
        for vkey, pool in (s.get("variations") or {}).items():
            if not isinstance(pool, list):
                continue
            for item in pool:
                text = str(item.get("text", "")) if isinstance(item, dict) else str(item)
                if NOT_APPLICABLE.match(text):
                    errs.append("%s: variations.%s 에 환자가 읽을 수 없는 \"%s\" 가 있음"
                                % (tag, vkey, text[:16]))

        # 병력 칸에 저자의 미결정이 남았는지
        for f in NOTE_FIELDS:
            val = s.get(f)
            if isinstance(val, str) and INDETERMINATE.search(val):
                errs.append("%s: %s 가 환자 사실을 미결정으로 남김 (%s)" % (tag, f, val[:30]))

        # 짝지은 슬롯은 길이가 같아야 자리끼리 맞물린다
        vars_ = s.get("variations") or {}
        for group in (s.get("pairedVariations") or []):
            miss = [k for k in group if k not in vars_]
            if miss:
                errs.append("%s: pairedVariations 의 %s 가 variations 에 없음" % (tag, ", ".join(miss)))
                continue
            if len({len(vars_[k]) for k in group}) > 1:
                errs.append("%s: 짝지은 슬롯 %s 의 값 개수가 다름" % (tag, ", ".join(group)))
        # 한 슬롯이 두 묶음에 걸리면 한쪽 묶음만 맞춰진다. 케톤산증 카드가
        # "작년에 당뇨 진단"이라 답하는데 차트엔 "진단받은 적 없음"이 찍혔다. 한 묶음으로 합칠 것.
        seen_pair = {}
        for group in (s.get("pairedVariations") or []):
            for k in group:
                if k in seen_pair and seen_pair[k] is not group:
                    errs.append("%s: 슬롯 %s 가 두 짝 묶음에 걸림 — 한 묶음으로 합칠 것" % (tag, k))
                seen_pair[k] = group

        # informant 가 문자열이면 보호자 관계 자리에 설명문이 통째로 찍힌다
        info = s.get("informant")
        if info is not None and not isinstance(info, dict):
            errs.append("%s: informant 는 relation 을 가진 객체여야 한다" % tag)
        elif isinstance(info, dict) and not info.get("relation"):
            errs.append("%s: informant.relation 없음" % tag)

        disc = s.get("disclosure") or {}
        if not disc.get("onlyIfAsked"):
            warns.append("%s: disclosure.onlyIfAsked 없음 — 물어야 나오는 정보가 없으면 문진 난이도가 사라진다" % tag)

        pe = s.get("pe") or {}
        if not exempt:
            if not pe:
                errs.append("%s: pe 없음" % tag)
            else:
                v = pe.get("vitals")
                if not isinstance(v, dict):
                    errs.append("%s: pe.vitals 가 밴드 형식이 아님" % tag)
                else:
                    for k in VITAL_KEYS:
                        band = v.get(k)
                        if not isinstance(band, list) or len(band) != 2:
                            errs.append("%s: vitals.%s 밴드 형식 오류" % (tag, k))
                        elif band[0] > band[1]:
                            errs.append("%s: vitals.%s 상하한 뒤바뀜" % (tag, k))
                    if not v.get("invariant"):
                        warns.append("%s: vitals.invariant 없음" % tag)
                for key, val in (pe.get("findings") or {}).items():
                    if isinstance(val, dict):
                        pv = val.get("p")
                        if not isinstance(pv, (int, float)) or not (0 < pv < 1):
                            errs.append("%s: 확률 소견 p 값 오류 (%s)" % (tag, key))
                        if not val.get("detected") or not val.get("notDetected"):
                            errs.append("%s: 확률 소견에 detected/notDetected 누락 (%s)" % (tag, key))
                # 확률 소견만으로 진단이 걸려 있으면 절반의 세션에서 진찰이 통째로 정상이 된다.
                # 항상 나오는 확정 단서를 반드시 명시하게 한다.
                if any(isinstance(v, dict) for v in (pe.get("findings") or {}).values()):
                    core = pe.get("_deterministicCore") or []
                    if not core:
                        errs.append("%s: 확률 소견이 있는데 _deterministicCore 가 없음" % tag)
                    else:
                        for c in core:
                            if c not in (pe.get("findings") or {}):
                                errs.append("%s: _deterministicCore 의 '%s' 가 findings 에 없음" % (tag, c))
                if len(pe.get("findings") or {}) < 5:
                    warns.append("%s: pe.findings 가 5개 미만 — 학생이 시도할 진찰을 덮지 못한다" % tag)

        # 변주 값 안에 또 슬롯이 들어 있으면 치환이 한 번에 끝나지 않아
        # 학생에게 {{side}} 같은 글자가 그대로 노출된다.
        for vkey, pool in (s.get("variations") or {}).items():
            if not isinstance(pool, list):
                continue
            for item in pool:
                text = str(item.get("text", "")) if isinstance(item, dict) else str(item)
                for nested in re.findall(r"\{\{(\w+)\}\}", text):
                    if nested in AUTO_SLOTS:
                        continue
                    errs.append("%s: variations.%s 값 안에 {{%s}} 가 중첩되어 있음"
                                % (tag, vkey, nested))

        # {{슬롯}} 이 variations 에 정의돼 있는지
        used = slots_used({k: v for k, v in s.items() if k != "variations"}, set())
        declared = set((s.get("variations") or {}).keys())
        for miss in sorted(used - declared - AUTO_SLOTS):
            errs.append("%s: {{%s}} 이 variations 에 없음" % (tag, miss))
        for unused in sorted(declared - used):
            warns.append("%s: variations.%s 가 쓰이지 않음" % (tag, unused))

    return name, errs, warns


def main(argv):
    prefix = argv[0] if argv else ""
    files = [p for p in sorted(glob.glob(os.path.join(CASES, "*.json")))
             if os.path.basename(p) not in ("personas.json", "index.json")
             and os.path.basename(p).startswith(prefix)]
    if not files:
        print("검사할 파일이 없습니다.")
        return 1

    total_e = total_w = 0
    scen = 0
    for p in files:
        name, errs, warns = check_file(p)
        try:
            scen += len(load(p).get("scenarios", []))
        except Exception:
            pass
        total_e += len(errs)
        total_w += len(warns)
        if errs or warns:
            print("\n%s" % name)
            for e in errs:
                print("  [오류] %s" % e)
            for w in warns[:12]:
                print("  [경고] %s" % w)
            if len(warns) > 12:
                print("  [경고] ... 그 외 %d건" % (len(warns) - 12))

    print("\n파일 %d개 · 시나리오 %d개 · 오류 %d건 · 경고 %d건"
          % (len(files), scen, total_e, total_w))
    return 1 if total_e else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

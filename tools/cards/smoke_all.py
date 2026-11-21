# -*- coding: utf-8 -*-
"""전 시나리오 실사용 점검

린터는 카드를 정적으로 보고, 이 스크립트는 실제로 뽑아서 나온 결과를 본다.
슬롯 치환 후에야 드러나는 문제 — 남은 {{슬롯}}, 기록용 칸에 섞인 환자 대사,
진찰 소견 칸에 들어간 환자 말투 — 를 잡는다.

    python smoke_all.py            시나리오당 5회
    python smoke_all.py 20         시나리오당 20회

슬롯 이름 노출, 직업 없는 인물의 직장 전제 낱말, 달력 날짜 고정, 첫 대사 시간어와
발병 시점 불일치도 여기서 본다 (2026-10-04 재통독에서 사람이 읽어 찾던 것들).
"""
from __future__ import unicode_literals
import io, json, os, re, sys, glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sample_case as sc

# 환자 구어체 종결어미. 이 칸들은 환자가 답하는 내용이라 구어체 자체는 정상이다.
SPEECH = re.compile(r"(요\.|요$|에요|예요|어요|아요|세요|네요|죠\.|죠$|드려요|같아요|대요|했어|있어|없어)")
# 카드 작성자가 모델에게 거는 지시문. 이게 환자 대사와 한 칸에 섞이면 잘못이다.
INSTRUCTION = re.compile(r"(인물 카드|카드를 따|redFlags|참고한다|그대로 쓴다|고정한다|따른다|덮어쓴다|해당 없으면|변주를 쓴다)")
NOTE_FIELDS = ["pmh", "meds", "allergy", "fh", "sh"]

# 조사가 잇달아 두 번 찍힌 것. 낱말 반복("내가 내가 아닌 것 같은")은 정상이라
# 조사만 본다.
CHART_SPEECH = re.compile(r"((?<=[가-힣])요[.!?]?(\s|,|$)|습니다)")
DUP_PARTICLE = re.compile("에서에서|으로으로|에게에게|부터부터|까지까지|하고하고|이다이다")

# 배경질환 약 이름. 카드 자신의 meds 칸이 이 이름을 그대로 적어 두면, 같은 병이
# 배경질환으로 또 뽑혔을 때 "암로디핀. 암로디핀" 처럼 겹친다 (12-나쁜소식,
# 13-두근거림에서 실제로 나왔다). 구체적인 약 이름이라 오탐 위험이 거의 없다.
# 직장을 전제한 낱말. 주부·은퇴자·무직·학생 인물의 칸에 나오면 안 된다
# ("일을 며칠 못 나갈까 봐", "같이 일하는 사람이", "아침 조회", "구내식당"이 그랬다).
# 직업에 매인 문장은 값에 occOnly 를 걸고, 카드 전체가 직업 전제면 occupationOnly 로 막는다.
WORK_PREMISE = re.compile(r"(출근|퇴근|회식|직장|동료|근무|업무|구내식당|아침 조회|못 나갈|못 나가게|같이 일하는|일하는 중에)")
NO_JOB = set(sc.OCC_GROUPS["집"]) | set(sc.OCC_GROUPS["학생"]) | {"infant", "preschool"}
# 면담 날짜와 상관없이 고정된 달력 날짜. 주수·발병 시점과 어긋난다("10월에 맞았어요", "1월 8일").
CALENDAR = re.compile(r"(?<![0-9~])(1[0-2]|[1-9])월 ?(초|말|중순|\d{1,2}일)?에?(?=[ .,]|$)")
# 첫 대사의 시간어가 뽑힌 발병 시점과 맞는지. (낱말, 발병 시간이 이 범위 밖이면 어긋남)
OPENING_TIME = [
    (re.compile(r"어제|어젯밤|어저께"), 10, 60),
    (re.compile(r"오늘"), 0, 24),
    (re.compile(r"며칠(?!씩)"), 36, 24 * 20),
    (re.compile(r"하루 사이|하룻밤"), 0, 48),
    (re.compile(r"몇 ?주"), 24 * 7, 24 * 90),
    (re.compile(r"(?<!지 )몇 ?(달|개월)"), 24 * 45, 10 ** 9),
    (re.compile(r"일주일|한 주"), 24 * 5, 24 * 14),
    (re.compile(r"(?<!지 )몇 ?년"), 24 * 300, 10 ** 9),
]
UNIT_H = {"시간": 1, "일": 24, "주": 168, "개월": 720, "년": 8760}


def onset_hours(text):
    m = re.search(r"(\d+)\s*(시간|일|주|개월|년)\s*전", text or "")
    return int(m.group(1)) * UNIT_H[m.group(2)] if m else None


_PERSONAS = sc.load(os.path.join(sc.CASES, "personas.json"))
BG_DRUGS = sorted(set(
    m for ill in _PERSONAS.get("backgroundIllness", []) for m in (ill.get("meds") or [])))


def scan(case, path, problems):
    """스킬이 실제로 받는 출력(as_json)에서 문제를 찾는다.
    build() 가 돌려주는 scenario 는 아직 치환 전이라 그걸 보면 안 된다."""
    out = sc.as_json(case)
    s = out["scenario"]

    def walk(node, where):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, "%s.%s" % (where, k))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, "%s[%d]" % (where, i))
        elif isinstance(node, str):
            if "{{" in node:
                problems.append("치환 안 된 슬롯 %s: %s" % (where, node[:50]))

    walk(s, "scenario")
    walk(out["pe"].get("findings") or {}, "findings")
    walk(out["person"], "person")

    # 한 칸에 지시문과 환자 대사가 섞였는지.
    # 지시문은 모델에게 거는 말이고 환자 대사는 학생에게 하는 말이라 섞이면 그대로 읽힌다.
    for f in NOTE_FIELDS:
        val = s.get(f)
        if isinstance(val, str) and INSTRUCTION.search(val) and SPEECH.search(val):
            problems.append("지시문과 환자 대사가 섞임 %s: %s" % (f, val[:52]))

    # 진찰 소견 칸에 환자 말투가 섞였는지 (서술자 톤이어야 한다)
    if not (case.get("_procedure") or case.get("_noPe")):
        for k, v in (out["pe"].get("findings") or {}).items():
            if not isinstance(v, str):
                continue
            if INSTRUCTION.search(v):
                problems.append("진찰 소견에 지시문 '%s': %s" % (k, v[:46]))
            # 정신상태평가 항목은 환자의 말을 그대로 인용하는 것이 정상이다
            MSE = ("사고", "병식", "정동", "기분", "지각", "말투", "판단", "인지", "외모·행동")
            if any(m in k for m in MSE):
                continue
            # 그 외 진찰 소견은 서술자의 말이므로 환자 1인칭 대사가 들어가면 안 된다
            if re.search(r"(제가|저는|아파요|없어요|있어요|같아요)", v):
                problems.append("진찰 소견에 환자 1인칭 대사 '%s': %s" % (k, v[:46]))

    # 현병력·동반증상·병력 칸은 차트 문구여야 한다. 대사가 들어가면 모델이 그 칸을
    # 그대로 읽어 준다(13-두근거림 경과 칸이 "금방 괜찮아졌어요.", 24-산전 진찰은
    # 현병력 전체가 대사였다). "요 며칠", "요즘" 은 대사가 아니므로 앞에 한글이 붙은
    # "…요" 만 본다.
    chart = [("hpi." + k, v) for k, v in (s.get("hpi") or {}).items()]
    chart += [("assoc." + k, x) for k, l in (s.get("assoc") or {}).items() for x in (l or [])]
    chart += [(k, s.get(k)) for k in ("pmh", "meds", "allergy", "fh", "sh")]
    for k, v in chart:
        if isinstance(v, str) and "'" not in v and CHART_SPEECH.search(v):
            problems.append("차트 칸에 대사 %s: %s" % (k, v[:50]))

    # 배경질환과 합쳐진 과거력이 주어를 잃지 않았는지.
    # "이상지질혈증. 처음이에요." 는 무엇이 처음인지 알 수 없다.
    pmh = s.get("pmh") or ""
    if re.match(r"^[^.]{2,20}\.\s*(이런 건 )?(처음|없어요|없습니다|없음)", pmh):
        problems.append("과거력이 주어를 잃음: %s" % pmh[:44])

    # 인물 값과 카드 값이 합쳐지며 뒤에 "없음"이 매달리지 않았는지.
    # "에스시탈로프람. 없음" 은 약이 있다는 건지 없다는 건지 알 수 없다.
    for key in ("pmh", "meds", "sh"):
        v = s.get(key) or ""
        if re.search(r"[^.]\.\s*(없음|없어요|복용 약 없음|특이사항 없음)\s*$", v):
            problems.append("병합 뒤에 '없음'이 매달림 %s: %s" % (key, v[:44]))

    # 배경질환 약이 카드 자신의 약과 겹쳐 같은 약 이름이 두 번 나오는지.
    # 카드가 그 병을 스스로 다루면서 forbidden 이나 _ownMeds 를 빠뜨렸을 때 생긴다.
    meds = s.get("meds") or ""
    for d in BG_DRUGS:
        if meds.count(d) >= 2:
            problems.append("약물 칸에 %s 중복: %s" % (d, meds[:50]))

    # 마침표가 겹쳐 찍혔는지. "{{slot}}. 그 외 문장" 꼴인데 slot 자신의 값도
    # 마침표로 끝나면 "...넣었어요.. 고혈압" 처럼 겹친다(13-두근거림에서 실제로 나왔다).
    for key in ("pmh", "meds", "allergy", "fh", "sh"):
        v = s.get(key) or ""
        if isinstance(v, str) and ".." in v:
            problems.append("마침표 겹침 %s: %s" % (key, v[:50]))

    # 슬롯 값과 템플릿의 조사가 겹쳤는지. 값이 이미 "…에서" 로 끝나는데 템플릿이
    # "{{slot}}에서" 라고 적으면 "고속도로에서 운전하다에서", "마트에서에서" 가 된다
    # (22-불안 공황 카드에서 세 값 중 둘이 그랬다). 치환 뒤에만 보인다.
    dup = DUP_PARTICLE.search(json.dumps(s, ensure_ascii=False))
    if dup:
        problems.append("조사 겹침: %s" % dup.group(0))

    # 첫 대사가 비어 있는지
    if not s.get("opening"):
        problems.append("opening 이 비어 있음")

    # 변주·활력징후 슬롯 이름이 {{}} 없이 글자 그대로 남았는지. 활력징후 값은 소견 칸에서
    # 치환되지 않아 대동맥박리 소견이 "좌우 수축기 혈압이 armDiff 만큼"으로 나왔다.
    raw = case["scenario"]
    names = set((raw.get("variations") or {}).keys())
    names |= {k for k in ((raw.get("pe") or {}).get("vitals") or {}) if re.match(r"^[a-z]+[A-Z]", k)}
    vals = []

    def strings(node, key=""):
        if key in ("pairedVariations", "_spBehavior", "id"):
            return
        if isinstance(node, dict):
            for k, v in node.items():
                strings(v, k)
        elif isinstance(node, list):
            for v in node:
                strings(v, key)
        elif isinstance(node, str):
            vals.append(node)
    strings([s, out["pe"].get("findings") or {}])
    text = "\n".join(vals)
    for n in names:
        if re.search(r"(?<![A-Za-z{])%s(?![A-Za-z}])" % re.escape(n), text):
            problems.append("슬롯 이름이 글자 그대로 남음: %s" % n)

    # 직업 없는 인물에게 직장 전제 낱말이 나왔는지. 환자 본인 몫의 칸만 본다
    # (보호자 대사·동행 설명에는 보호자 직장 이야기가 나올 수 있다).
    # 보호자가 대신 말하는 소아 카드는 보호자 직장 이야기가 섞여 있어 뺀다.
    p = case["person"]
    if p["occupation"]["id"] in NO_JOB and not (p.get("guardian") and not p.get("speaksForSelf")):
        own = list(s.get("opening") or []) + list((s.get("hpi") or {}).values())
        own += [x for l in (s.get("assoc") or {}).values() for x in (l or [])]
        own += [v for v in (s.get("redFlags") or {}).values() if isinstance(v, str)]
        own += [s.get(k) or "" for k in ("pmh", "meds", "sh")] + [out["person"]["ice"]]
        for v in own:
            m = WORK_PREMISE.search(v if isinstance(v, str) else "")
            # "과거 염색공장에서 오래 근무"처럼 예전 직업은 은퇴자에게도 맞다.
            # 학생에게 "학교나 일을 못 나갈까 봐"는 학교 쪽으로 맞는다.
            if m and re.search(r"(과거|예전|젊을 때)[^.]*" + re.escape(m.group(0)), v):
                continue
            if m and "학교" in v and p["occupation"]["id"] in sc.OCC_GROUPS["학생"]:
                continue
            if m:
                problems.append("직업 없는 인물에게 직장 전제: '%s' / %s" % (m.group(0), v[:44]))

    # 달력 날짜가 고정돼 있는지
    m = CALENDAR.search(json.dumps(s, ensure_ascii=False))
    if m:
        problems.append("달력 날짜 고정: %s" % m.group(0))

    # 첫 대사의 시간어와 발병 시점. "어제부터 열이 나요"처럼 발병 칸에도 같은 낱말이
    # 있으면 그 사건을 가리키는 것이라 넘어간다.
    onset = (s.get("hpi") or {}).get("onset") or ""
    h = onset_hours(onset)
    if h is not None:
        for line in s.get("opening") or []:
            for pat, lo, hi in OPENING_TIME:
                mm = pat.search(line)
                if mm and not pat.search(onset) and not (lo <= h <= hi):
                    problems.append("첫 대사 시간어와 발병 시점 어긋남: '%s' / 발병 %s / %s" % (mm.group(0), onset[:16], line[:30]))


def main(argv):
    reps = int(argv[0]) if argv else 5
    files = sc.topic_files()
    found = {}
    total = 0

    for topic, data in files:
        procedure = bool(data.get("_procedureCase"))
        no_pe = bool(data.get("_noPhysicalExam"))
        for scen in data["scenarios"]:
            for _ in range(reps):
                case = sc.build(topic, data, scen["id"])
                case["_procedure"] = procedure
                case["_noPe"] = no_pe
                total += 1
                probs = list(case["problems"])
                scan(case, topic, probs)
                for x in probs:
                    key = x.split(":")[0]
                    found.setdefault(key, set()).add("%s/%s · %s" % (topic, scen["id"], x))

    print("시나리오 %d개 · 추첨 %d회" % (sum(len(d["scenarios"]) for _, d in files), total))
    if not found:
        print("문제 0건")
        return 0
    n = sum(len(v) for v in found.values())
    print("문제 %d종" % n)
    for key in sorted(found, key=lambda k: -len(found[k])):
        rows = sorted(found[key])
        print("\n[%s] %d종" % (key, len(rows)))
        for r in rows[:10]:
            print("   %s" % r)
        if len(rows) > 10:
            print("   ... 그 외 %d종" % (len(rows) - 10))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

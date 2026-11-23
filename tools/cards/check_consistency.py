# -*- coding: utf-8 -*-
"""카드 정합성 검토 목록 (사람이 읽고 판단하는 후보 목록 — CI 실패 조건이 아니다)

check_contradictions.py 는 "음성 소견 vs 활력징후"처럼 확실한 모순만 막는다. 이 도구는 그보다 넓게,
사람이 한 번 봐야 할 후보를 뽑는다. 낱말 비교라 틀린 후보도 섞인다.

    python check_consistency.py            전체
    python check_consistency.py 18         파일명 접두사로 좁히기

보는 것
  A. 양성 증상·본문에 발열이 있는데 체온 밴드 상한이 37.5 미만
  B. 환자가 말하는 체온(예: "38도 후반")과 체온 밴드가 크게 어긋남
  C. 같은 증상이 양성과 음성에 같이 있음
  D. Red flag 답이 "있다"인데 같은 증상이 음성 목록에 있음 / 답이 "없다"인데 양성 목록에 있음
  E. 남성 고정 시나리오에 월경·임신 서술, 여성 고정 시나리오에 전립선·고환 서술
  F. 양성에 두근거림·숨참이 있는데 맥박·호흡·산소포화도 밴드가 모두 정상 (증상이 간헐적일 수 있어 참고용)
  G. 현병력·첫 대사가 한쪽(오른쪽/왼쪽)만 말하는데 진찰 소견은 반대쪽만 말함
"""
from __future__ import unicode_literals
import io, json, os, re, sys, glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.normpath(os.path.join(HERE, "..", "..", "src", "cases"))

TAIL = re.compile(r"(이나|에서|으로|하거나|거나|하나|한가|하게|하면|으면|는지|은지|인지|는|은|이|가|을|를|에|도|나|요|고|면|게|의|와|과|함|음|없음|있음)$")
STOP = {"없음", "있음", "없다", "있다", "조금", "가끔", "자주", "최근", "평소", "약간", "정도", "때문", "같은", "느낌", "증상", "아픈", "통증",
        "있나", "없나", "언제", "얼마", "어느", "전에", "그런", "이런", "없어", "있어", "아니", "네", "아뇨", "하고", "그냥", "많이", "계속"}


def load(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def texts_of(node, out):
    if isinstance(node, dict):
        for v in node.values():
            texts_of(v, out)
    elif isinstance(node, list):
        for v in node:
            texts_of(v, out)
    elif isinstance(node, str):
        out.append(node)
    return out


def stems(text):
    out = set()
    for w in re.split(r"[^가-힣]+", re.sub(r"\([^)]*\)", " ", text or "")):
        t = TAIL.sub("", w)
        if len(t) >= 2 and t not in STOP:
            out.add(t[:2])
    return out


def strip_neg(item):
    """'기침 없음' → '기침'"""
    return re.sub(r"\s*(은|는|이|가)?\s*(없음|없다|없어요|안 함|아님|아니다|않음)\s*$", "", item or "")


POS_ANSWER = re.compile(r"^\s*(네|예|응|있어|있었|그래|맞아|좀|조금|약간|가끔|자주|한두|두세|몇 번)")
NEG_ANSWER = re.compile(r"^\s*(아니|아뇨|없어|없었|안 |그런 건 없|그런 적 없|전혀)")
FEVER = re.compile(r"(?<![무미고])(발열|열이 (나|났|올)|열감|오한|고열)")
SAID_TEMP = re.compile(r"(3[6-9]|4[0-1])(\.\d)?\s*도\s*(초반|중반|후반|넘|까지|가까이)?")


def check(fname, s):
    out = []
    pe = s.get("pe") or {}
    vit = pe.get("vitals") or {}
    assoc = s.get("assoc") or {}
    pos = assoc.get("positive") or []
    neg = assoc.get("negative") or []
    rf = s.get("redFlags") or {}
    body = " / ".join(texts_of({k: v for k, v in s.items() if k not in ("pe", "variations", "pairedVariations", "constraints")}, []))
    temp = vit.get("temp") if isinstance(vit.get("temp"), list) else None

    # A
    pos_blob = " / ".join(pos) + " / " + " / ".join(texts_of(s.get("hpi") or {}, []))
    if temp and temp[1] < 37.5 and FEVER.search(pos_blob):
        out.append("A 발열 서술(%s)인데 체온 밴드 %s" % (FEVER.search(pos_blob).group(0), temp))

    # B
    if temp:
        for m in SAID_TEMP.finditer(body):
            said = float(m.group(1) + (m.group(2) or ""))
            if m.group(3) == "후반":
                said += 0.7
            elif m.group(3) == "중반":
                said += 0.5
            if said >= 38.0 and temp[1] < 37.8:
                out.append("B 환자가 '%s'라고 하는데 체온 밴드 %s" % (m.group(0), temp))
            if said < 37.5 and temp[0] >= 38.0:
                out.append("B 환자가 '%s'라고 하는데 체온 밴드 %s" % (m.group(0), temp))

    # C
    for p in pos:
        ps = stems(p)
        for n in neg:
            common = ps & stems(strip_neg(n))
            if common:
                out.append("C 양성 '%s' / 음성 '%s' (공통: %s)" % (p, n, ",".join(sorted(common))))

    # D
    for q, a in rf.items():
        if not isinstance(a, str) or "{{" in a:
            continue
        qs = stems(q)
        if POS_ANSWER.search(a):
            for n in neg:
                common = qs & stems(strip_neg(n))
                if common:
                    out.append("D RF '%s' → '%s' 인데 음성 '%s'" % (q, a, n))
        elif NEG_ANSWER.search(a):
            for p in pos:
                common = qs & stems(p)
                if common:
                    out.append("D RF '%s' → '%s' 인데 양성 '%s'" % (q, a, p))

    # E
    sex = s.get("sex") or (s.get("constraints") or {}).get("sex")
    if sex == "male" and re.search(r"월경|생리(?!식염)|임신|폐경|자궁|난소", body):
        out.append("E 남성 시나리오인데 월경·임신·자궁 서술")
    if sex == "female" and re.search(r"전립선|고환|음낭", body):
        out.append("E 여성 시나리오인데 전립선·고환 서술")

    # F
    hr, rr, sp = vit.get("hr"), vit.get("rr"), vit.get("spo2")
    pblob = " / ".join(pos)
    if re.search(r"두근|심장이 빨리", pblob) and isinstance(hr, list) and hr[1] < 100:
        out.append("F 양성에 두근거림인데 맥박 밴드 %s (간헐적이면 정상)" % hr)
    if re.search(r"숨이 차|숨참|호흡곤란", pblob) and isinstance(rr, list) and rr[1] <= 20 and isinstance(sp, list) and sp[0] >= 96:
        out.append("F 양성에 숨참인데 호흡 %s · 산소포화도 %s (운동 시만이면 정상)" % (rr, sp))
    # G
    def sides(t):
        return {x for x in ("오른", "왼") if re.search(x + r"(쪽|편)", t)} | ({"오른"} if re.search(r"우(하|상)복부|우측", t) else set()) | ({"왼"} if re.search(r"좌(하|상)복부|좌측", t) else set())
    story = " / ".join(texts_of(s.get("hpi") or {}, [])) + " / " + " / ".join(s.get("opening") or [] if isinstance(s.get("opening"), list) else [s.get("opening") or ""])
    fnd = " / ".join(texts_of(pe.get("findings") or {}, []))
    hs, fs = sides(story), sides(fnd)
    if len(hs) == 1 and len(fs) == 1 and hs != fs and "{{" not in story:
        out.append("G 현병력은 %s쪽인데 진찰 소견은 %s쪽만" % (list(hs)[0], list(fs)[0]))
    return out


def main(argv):
    prefix = argv[1] if len(argv) > 1 else ""
    total = 0
    for p in sorted(glob.glob(os.path.join(CASES, "*.json"))):
        name = os.path.basename(p)[:-5]
        if name in ("index", "personas") or not name.startswith(prefix):
            continue
        data = load(p)
        for s in data.get("scenarios") or []:
            items = check(name, s)
            for it in items:
                print("%s %s  %s" % (name, s.get("id"), it))
            total += len(items)
    print("후보 %d건" % total)


if __name__ == "__main__":
    main(sys.argv)

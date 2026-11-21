# -*- coding: utf-8 -*-
"""주호소별 채점표 ↔ 카드 근거 점검기

채점표(refs/checklists/NN-xxx.md)는 주호소 하나의 모든 시나리오 질문을 모아 놓은 것이라,
지금 뽑힌 시나리오 카드에 답이 없는 항목이 섞여 있다. SKILL.md 의 평가 규칙은 그런 항목을
"해당 없음"으로 빼고 남은 항목으로 환산한다. 이 도구는 시나리오마다 채점표 항목별로 카드에
근거가 있는지 키워드로 어림해서, 사람이 훑어볼 표를 만든다.

    python audit_checklist_coverage.py                 전체 요약
    python audit_checklist_coverage.py 21              파일명 접두사로 좁히기 (상세 표 출력)
    python audit_checklist_coverage.py --md out.md     전체 상세 표를 파일로 저장
    python audit_checklist_coverage.py --dead          어느 시나리오에도 근거가 없는 항목만

주의: 키워드 일치로 어림한 결과라 정답이 아니다. "근거 없음"은 (1) 정말 그 시나리오와 무관한
항목이거나 (2) 카드에 답을 안 적은 것이다. 후자면 카드를 보강하고, 전자면 그대로 둔다.
채점표 마지막 섹션(추정진단·검사·치료·재방문)은 항상 적용이라 점검하지 않는다.
항상 종료 코드 0 이다(참고용, check_all 에 넣지 않는다).
"""
from __future__ import unicode_literals
import io, json, os, re, sys, glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.normpath(os.path.join(HERE, "..", "..", "refs"))
CASES = os.path.normpath(os.path.join(HERE, "..", "..", "src", "cases"))
CHECKS = os.path.join(REFS, "checklists")

# 채점 항목에서 의미가 없는 일반 단어
STOP = set("""
확인 여부 시기 있는지 없는지 질문 설명 병력 증상 동반 요인 정도 이전 과거 유사 최근 시작 변화 관계 상황
원인 감별 환자 검사 필수 나열 항목 경우 또는 그리고 함께 대신 이번 해당 만점 진단 있는 없는 하는 한다
여부를 있으면 없으면 필요 가능 가능성 위험 위험인자 신호 응급 기준 추가 다른 여러 모든 전부 일부 하나
""".split())
# 진찰 항목은 술기 동사가 핵심이라 덜 거른다
STOP_PE = STOP - set()

# 통증 자체 항목: 채점표 용어 → 카드 hpi 키
DIM = {
    "발병": ["onset"], "시기": ["onset"], "경과": ["course", "timing"], "지속": ["timing", "course"],
    "빈도": ["timing", "course"], "위치": ["location"], "방사": ["radiation"], "양상": ["character"],
    "성상": ["character"], "강도": ["severity"], "악화": ["aggravating"], "완화": ["relieving"],
}
# 채점표 용어 → 카드에서 흔히 쓰는 다른 표현
SYN = {
    "간경변": ["간경화", "간경변"], "흉통": ["가슴통증", "가슴이", "흉통"], "호흡곤란": ["숨이", "숨참", "숨찬", "호흡곤란"],
    "두통": ["머리가", "두통", "머리아"], "열": ["발열", "미열", "열이"], "오한": ["오한", "오슬"],
    "활력징후": ["혈압", "맥박", "체온", "산소포화도"], "체온": ["체온", "발열", "열"], "혈압": ["혈압"],
    "이전": ["과거", "전에", "이전"], "혈변": ["혈변", "피가", "피를"], "검은변": ["검은변", "흑색변", "까만"],
    "야간": ["밤", "야간", "새벽"], "피로": ["피로", "기운", "무기력"], "체중": ["체중", "몸무게", "살이"],
    "다이어트": ["다이어트", "식이", "감량"], "복용": ["복용", "먹", "약"], "가족력": ["가족력", "아버지", "어머니", "가족"],
    "머리외상": ["머리를", "외상", "부딪"], "외상": ["외상", "부딪", "다쳤", "다친"],
    "월경": ["월경", "생리"], "갑상샘": ["갑상샘", "갑상선"], "소염진통제": ["소염진통", "진통소염", "진통제"],
    "식욕": ["식욕", "입맛"], "스트레스": ["스트레스", "긴장", "힘든"], "카페인": ["카페인", "커피"],
    "하제": ["하제", "변비약", "관장"], "인후염": ["인후", "목이", "목감기"], "야간뇨": ["야간뇨", "밤에"],
    "야간": ["밤", "야간", "새벽", "밤에"], "반복": ["반복", "재발", "전에도", "예전에도"],
    "호전": ["호전", "나아", "relieving"], "탈수": ["탈수", "핑", "어지", "입이마"], "빈혈": ["빈혈", "어지", "피곤", "창백"],
    "근육통": ["근육통", "몸살"], "항응고제": ["항응고", "피가안", "피나오는", "아스피린", "와파린"],
    "다이어트": ["다이어트", "식이", "감량", "식사량"], "가정혈압": ["집에서", "가정혈압"], "이전": ["이전", "전에", "과거", "예전"],
    "심장": ["심장", "심음"], "정신상태": ["정신상태", "인지", "지남력"], "오한": ["오한", "오슬", "열"],
}
# 인물 카드가 채우는 항목(카드에 안 써도 근거가 있다고 본다)
PERSONA = ["흡연", "음주", "직업", "사회력", "월경력", "산과력"]
# 학생의 태도·방식을 보는 항목은 카드 근거를 찾지 않는다
BEHAVIOR = ["직접 묻기", "캐묻지", "비난 없이", "판단하지"]


def load(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def strings(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            out.append(str(k))
            strings(v, out)
    elif isinstance(node, list):
        for v in node:
            strings(v, out)
    elif isinstance(node, str):
        out.append(node)
    elif isinstance(node, (int, float)):
        out.append(str(node))
    return out


def scenario_corpora(card, sc):
    hist = []
    for key, val in sc.items():
        if key in ("pe", "constraints", "occupationBias", "iceHint", "id", "dx"):
            continue
        strings(val, hist)
    strings(sc.get("constraints", {}).get("ageRange", ""), hist)
    pe = []
    if "pe" in sc:
        p = sc["pe"]
        for key in ("findings", "negatives"):
            if key in p:
                strings(p[key], pe)
    if "pe" in sc and sc["pe"].get("vitals"):
        pe.append("활력징후 혈압 맥박 호흡 체온 산소포화도 체중")
    for key in ("peFocus", "requiredSkill"):
        if key in card:
            strings(card[key], pe)
    return re.sub(r"\s+", "", "\n".join(hist)), re.sub(r"\s+", "", "\n".join(pe))


def tokens(text, stop):
    text = re.sub(r"\([^)]*\)", " ", text)          # 괄호 안 설명 제외
    text = text.replace("→", " ")
    toks = []
    for t in re.split(r"[\s·,/\-—~.:;]+", text):
        t = re.sub(r"(이|가|은|는|을|를|의|에|과|와|도|로|인지|는지|했는지|하는지|여부)$", "", t)
        t = t.strip()
        if len(t) < 2 or t in stop or re.fullmatch(r"[0-9A-Za-z]+", t):
            continue
        toks.append(t)
    return toks


def stem(t):
    return t[:3] if len(t) >= 4 else t


def evidence(item_text, block, section, hist, pe, sc):
    """근거가 있으면 (True, 이유) 없으면 (False, '')"""
    head = item_text.split("—")[0]
    if any(w in item_text for w in BEHAVIOR):
        return True, "태도 항목"
    if block == "hist":
        if any(w in item_text for w in PERSONA):
            return True, "인물 카드"
        hpi = sc.get("hpi", {})
        for term, keys in DIM.items():
            if section.startswith("A.") and term in re.split(r"[\s·,/]+", head):
                for k in keys:
                    v = hpi.get(k)
                    if v and str(v).strip() not in ("", "없음"):
                        return True, "hpi." + k
        corpus, stop = hist, STOP | set("가슴 머리 복부 진단이나 진단 시술".split())
    else:
        corpus, stop = pe, STOP_PE
    for t in tokens(item_text, stop):
        if stem(t) in corpus:
            return True, t
        for alt in SYN.get(t, []):
            if alt in corpus:
                return True, t + "~" + alt
    return False, ""


def parse_checklist(path):
    """[(block, section, text, pts)] — block: hist / pe / fin"""
    items = []
    block = "hist"
    section = ""
    with io.open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("## 신체진찰"):
                block = "pe"
            elif line.startswith("## 추정진단"):
                block = "fin"
            m = re.match(r"### ([A-H])\. (.+?)(?: \(\d+점\))?$", line)
            if m:
                section = m.group(1) + ". " + m.group(2)
                continue
            m = re.match(r"- \[ \] (.+) \((\d+)\)(?:\s*—.*)?$", line) or re.match(r"- \[ \] (.+) \((\d+)\)", line)
            if m:
                items.append((block, section, m.group(1), int(m.group(2))))
    return items


def audit(name):
    card = load(os.path.join(CASES, name + ".json"))
    items = [i for i in parse_checklist(os.path.join(CHECKS, name + ".md")) if i[0] != "fin"]
    result = []
    for sc in card["scenarios"]:
        hist, pe = scenario_corpora(card, sc)
        marks = []
        for block, section, text, pts in items:
            ok, why = evidence(text, block, section, hist, pe, sc)
            marks.append((ok, why))
        result.append((sc["id"], marks))
    return items, result


def summarize(name, items, result, detail=False, md=None):
    hist_max = sum(p for b, _, _, p in items if b == "hist")
    pe_max = sum(p for b, _, _, p in items if b == "pe")
    print("== %s  (병력 %d점 · 진찰 %d점)" % (name, hist_max, pe_max))
    for sid, marks in result:
        na_h = sum(items[i][3] for i, (ok, _) in enumerate(marks) if not ok and items[i][0] == "hist")
        na_p = sum(items[i][3] for i, (ok, _) in enumerate(marks) if not ok and items[i][0] == "pe")
        print("   %-28s 근거 없음: 병력 %2d점 · 진찰 %2d점" % (sid, na_h, na_p))
    dead = [items[i] for i in range(len(items)) if not any(m[i][0] for _, m in result)]
    if dead:
        print("   어느 시나리오에도 근거 없음:")
        for b, sec, text, pts in dead:
            print("     - [%s] %s (%d)" % (sec[:1] if sec else b, text[:60], pts))
    if detail or md is not None:
        lines = []
        head = "| 절 | 항목 | 배점 | " + " | ".join(s for s, _ in result) + " |"
        lines.append("### " + name)
        lines.append(head)
        lines.append("|" + "---|" * (3 + len(result)))
        for i, (b, sec, text, pts) in enumerate(items):
            cells = []
            for _, marks in result:
                ok, why = marks[i]
                cells.append(("✔ " + why) if ok else "·")
            lines.append("| %s | %s | %d | %s |" % (sec[:1] if sec else b, text.replace("|", "/"), pts, " | ".join(cells)))
        lines.append("")
        if md is not None:
            md.extend(lines)
        else:
            print("\n".join(lines))


def main(argv):
    md_path = None
    only_dead = "--dead" in argv
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--md":
            md_path = argv[i + 1]
            i += 2
            continue
        if argv[i].startswith("--"):
            i += 1
            continue
        args.append(argv[i])
        i += 1
    names = sorted(os.path.basename(p)[:-3] for p in glob.glob(os.path.join(CHECKS, "*.md")))
    if args:
        names = [n for n in names if any(n.startswith(a) for a in args)]
    md = [] if md_path else None
    for n in names:
        if not os.path.exists(os.path.join(CASES, n + ".json")):
            print("== %s  카드 없음" % n)
            continue
        items, result = audit(n)
        if only_dead:
            dead = [items[i] for i in range(len(items)) if not any(m[i][0] for _, m in result)]
            if dead:
                print("== %s" % n)
                for b, sec, text, pts in dead:
                    print("   - [%s] %s (%d)" % (sec[:1] if sec else b, text[:70], pts))
            continue
        summarize(n, items, result, detail=bool(args) and md is None, md=md)
    if md_path:
        with io.open(md_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("# 채점표 ↔ 카드 근거 점검 (키워드 어림)\n\n✔ 근거 있음(일치한 단어) · 근거 없음\n\n" + "\n".join(md))
        print("저장:", md_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

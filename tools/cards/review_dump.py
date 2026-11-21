# -*- coding: utf-8 -*-
"""통독용 검토지 생성기

카드를 실제로 뽑아 사람이(또는 검토 에이전트가) 읽을 수 있는 형태로 펼친다.
기계 검사기가 못 잡는 것 — 문장이 어색한지, 슬롯끼리 앞뒤가 맞는지, 임상적으로
말이 되는지 — 은 결국 읽어야 나온다. 이 스크립트는 읽기 좋게 만들어 줄 뿐이다.

    python review_dump.py 21              해당 주호소를 3회씩 뽑아 출력
    python review_dump.py 21 --draws 5    더 여러 번 뽑아 슬롯 조합을 넓게 본다
    python review_dump.py --all --out ../../../review   전 주호소를 파일로 저장
"""
from __future__ import unicode_literals
import io, os, sys, glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sample_case as sc

HPI_ORDER = ["onset", "character", "location", "radiation",
             "aggravating", "relieving", "severity", "course", "timing"]


def block(title, body, L):
    if not body:
        return
    L.append("  %s" % title)
    for line in body:
        L.append("    %s" % line)
    L.append("")


def render(case, draw_no):
    out = sc.as_json(case)
    s, p, pe = out["scenario"], out["person"], out["pe"]
    L = []
    L.append("─" * 74)
    L.append("[%s / %s] %s   (%d번째 추첨)" % (
        out["topicFile"], out["scenarioId"], out["dx"], draw_no))
    L.append("")
    L.append("  인물   %s %s세 %s · %s · %s / 건강정보 %s" % (
        p["name"], p["age"], p["sex"], p["occupation"],
        p["personality"], p["healthLiteracy"]))
    habits = "" if p["age"] < sc.ADULT_AGE else " · 흡연 %s · 음주 %s" % (p["smoking"], p["alcohol"])
    L.append("  배경   %s%s%s" % (
        p["backgroundIllness"], habits,
        ("  (필수 위험인자 %s)" % ", ".join(p["forcedRisk"])) if p.get("forcedRisk") else ""))
    L.append("  ICE    %s" % p["ice"])
    if p.get("guardian"):
        g = p["guardian"]
        rel = g["role"].get("relation") if isinstance(g["role"], dict) else g["role"]
        L.append("  보호자 %s %s세 %s · %s · %s / 건강정보 %s%s" % (
            rel, g["age"], g["sex"], g["occupation"],
            g.get("personality", "-"), g.get("healthLiteracy", "-"),
            "  (카드 voice 우선)" if g.get("voiceWins") else ""))
        L.append("  본인응답 %s" % ("가능" if p.get("speaksForSelf") else "불가"))
    L.append("")

    if s.get("situation"):
        block("상황", [s["situation"]], L)
    block("첫 대사", list(s.get("opening") or []), L)

    hpi = s.get("hpi") or {}
    block("현병력", ["%-12s %s" % (k, hpi[k]) for k in HPI_ORDER if hpi.get(k)], L)

    assoc = s.get("assoc") or {}
    if assoc:
        block("동반증상", ["양성  %s" % ", ".join(assoc.get("positive") or []),
                       "음성  %s" % ", ".join(assoc.get("negative") or [])], L)

    rf = s.get("redFlags") or {}
    block("Red flag 문답", ["Q %s\n      A %s" % (q, a) for q, a in rf.items()], L)

    hx = [("과거력", s.get("pmh")), ("약물", s.get("meds")), ("알레르기", s.get("allergy")),
          ("가족력", s.get("fh")), ("사회력", s.get("sh"))]
    block("병력", ["%-8s %s" % (k, v) for k, v in hx if v], L)

    v = pe.get("vitals") or {}
    if "sbp" in v:
        line = "혈압 %s/%s · 맥박 %s · 호흡 %s · 체온 %s · SpO2 %s" % (
            v["sbp"], v["dbp"], v["hr"], v["rr"], v["temp"], v["spo2"])
        if "armDiff" in v:
            line += " · 양팔차 %s" % v["armDiff"]
        extra = []
        if v.get("_shiftedBy"):
            extra.append("변주로 이동됨: %s" % ", ".join(v["_shiftedBy"]))
        block("활력징후", [line] + extra + ["invariant: %s" % v.get("invariant", "")], L)

    fnd = pe.get("findings") or {}
    if fnd:
        rows = []
        rolled = {r["finding"]: r for r in out.get("rolledProbabilistic") or []}
        for k, val in fnd.items():
            tag = ""
            if k in rolled:
                tag = "  [확률 %.1f · %s]" % (rolled[k]["p"], "잡힘" if rolled[k]["detected"] else "안 잡힘")
            rows.append("%-16s %s%s" % (k, val, tag))
        block("진찰 소견", rows, L)
        if pe.get("_deterministicCore"):
            block("대표 소견(확정)", [", ".join(pe["_deterministicCore"])], L)

    if s.get("expectedSequence"):
        block("수행 순서", ["%d. %s\n      → %s" % (i + 1, st["step"], st["correct"])
                        for i, st in enumerate(s["expectedSequence"])], L)
    if s.get("distractors"):
        block("함정", ["%s → %s" % (d["action"], d["result"]) for d in s["distractors"]], L)
    if s.get("counselingTargets"):
        block("상담 목표%s" % ("  (단계: %s)" % s["stage"] if s.get("stage") else ""),
              list(s["counselingTargets"]), L)
    if s.get("reaction"):
        block("반응", ["%s → %s" % (k, val) for k, val in s["reaction"].items()], L)

    d = s.get("disclosure") or {}
    block("공개 규칙", ["먼저 말함    %s" % ", ".join(d.get("spontaneous") or []),
                   "물어야 나옴  %s" % ", ".join(d.get("onlyIfAsked") or [])], L)

    # 밑줄로 시작하는 칸은 아래 catch-all 이 건너뛴다. 연기 지시는 학생에게 읽히면
    # 안 되지만 통독에서는 읽어야 하므로 여기서 따로 보여준다.
    if s.get("_spBehavior"):
        block("연기 지시(학생에게 읽지 않음)", [s["_spBehavior"]], L)

    # 위에서 따로 그리지 않은 칸도 반드시 보여준다. 검토지에 안 나오는 칸은
    # 통독에서 읽히지 않고, 읽지 않은 칸의 결함은 영원히 남는다.
    DRAWN = {"situation", "opening", "hpi", "assoc", "redFlags", "pmh", "meds",
             "allergy", "fh", "sh", "expectedSequence", "distractors",
             "counselingTargets", "stage", "reaction", "disclosure", "dx", "id"}
    for key, val in s.items():
        if key in DRAWN or key.startswith("_") or not val:
            continue
        if isinstance(val, dict):
            body = ["%-14s %s" % (k, v) for k, v in val.items()]
        elif isinstance(val, list):
            body = [("- %s" % v) if not isinstance(v, dict) else
                    ("- " + ", ".join("%s: %s" % kv for kv in v.items())) for v in val]
        else:
            body = [str(val)]
        block(key, body, L)

    if case["problems"]:
        block("규칙 위반", case["problems"], L)
    return "\n".join(L)


def main(argv):
    draws = 3
    if "--draws" in argv:
        i = argv.index("--draws")
        draws = int(argv[i + 1]); del argv[i:i + 2]
    out_dir = None
    if "--out" in argv:
        i = argv.index("--out")
        out_dir = argv[i + 1]; del argv[i:i + 2]
    do_all = "--all" in argv
    argv = [a for a in argv if not a.startswith("--")]

    files = sc.topic_files()
    if not do_all:
        pref = argv[0] if argv else ""
        files = [(t, d) for t, d in files if t.startswith(pref)]
        if not files:
            print("그런 주호소가 없습니다:", pref)
            return 1

    if out_dir:
        out_dir = os.path.abspath(out_dir)
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)

    total = 0
    for topic, data in files:
        parts = ["# %s (%s)\n" % (data["topic"], topic),
                 "시나리오 %d개 · 각 %d회 추첨\n" % (len(data["scenarios"]), draws)]
        for scen in data["scenarios"]:
            for n in range(1, draws + 1):
                parts.append(render(sc.build(topic, data, scen["id"]), n))
                total += 1
        text = "\n".join(parts)
        if out_dir:
            p = os.path.join(out_dir, topic + ".txt")
            io.open(p, "w", encoding="utf-8").write(text)
            print("%-32s %d개 시나리오 → %s" % (topic, len(data["scenarios"]), p))
        else:
            print(text)
    if out_dir:
        print("\n주호소 %d개 · 추첨 %d회 저장" % (len(files), total))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

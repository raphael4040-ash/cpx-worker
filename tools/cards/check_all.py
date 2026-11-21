# -*- coding: utf-8 -*-
"""카드 전체 점검 — 다섯 검사기를 한 번에 돌린다.

카드를 고친 뒤에는 항상 이것부터 돌린다. 하나라도 실패하면 종료 코드가 1이라
git 훅이나 CI 에 그대로 걸 수 있다.

    python check_all.py           기본 (시나리오당 10회)
    python check_all.py 30        더 촘촘히
    python check_all.py --quiet   실패한 것만 출력
"""
from __future__ import unicode_literals
import os, subprocess, sys, time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))


def run(label, args, why):
    t0 = time.time()
    p = subprocess.run([sys.executable] + args, cwd=HERE,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    tail = [l for l in out.splitlines() if l.strip()][-1:] or [""]
    return {
        "label": label, "ok": p.returncode == 0, "summary": tail[0].strip(),
        "output": out, "secs": time.time() - t0, "why": why,
    }


def main(argv):
    quiet = "--quiet" in argv
    argv = [a for a in argv if not a.startswith("--")]
    reps = argv[0] if argv else "10"
    draws = str(int(reps) * 500)

    checks = [
        run("형식", ["lint_cases.py"],
            "필드 누락·활력징후 밴드 형식·중첩 슬롯·확률 소견 형식"),
        run("내부 모순", ["check_contradictions.py"],
            "음성 소견과 활력징후가 부딪히는지, 먼저 말할 것과 물어야 할 것이 겹치는지, 첫 대사가 답을 흘리는지"),
        run("조합 규칙", ["sample_case.py", "--check", draws],
            "나이·직업·흡연·성별 제약과 상충 조합"),
        run("실사용 출력", ["smoke_all.py", reps],
            "치환 후에야 드러나는 것 — 남은 슬롯, 지시문 노출, 과거력 주어 유실"),
        run("카드 계약", ["check_contract.py", reps],
            "카드가 선언한 조건(값 조건·짝 묶음·직업 고정·금지 지병·형제 나이)을 추첨 결과가 지키는지. 워커 cardContract.test.mjs 와 같은 검사"),
    ]

    failed = [c for c in checks if not c["ok"]]
    width = max(len(c["label"]) for c in checks)
    print()
    for c in checks:
        mark = "  " if c["ok"] else "!!"
        print("%s %-*s  %-46s %4.1fs" % (mark, width, c["label"], c["summary"][:46], c["secs"]))
    if not quiet:
        print()
        for c in checks:
            print("   %-*s %s" % (width, c["label"], c["why"]))

    if failed:
        print("\n실패 %d개 — 아래 출력을 보고 고친 뒤 다시 돌리세요.\n" % len(failed))
        for c in failed:
            print("─" * 60)
            print("[%s]" % c["label"])
            print(c["output"].strip()[:3000])
        return 1

    print("\n전부 통과. 배포해도 됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

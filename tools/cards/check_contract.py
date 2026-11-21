# -*- coding: utf-8 -*-
"""카드 계약 검사 — 카드가 선언한 조건을 샘플러가 실제로 지키는가

케이스 추첨 규칙은 tools/cards/sample_case.py 와 src/sampleCase.js 두 곳에
따로 있다. 카드에 새 조건(occOnly, drinkerOnly, occupationOnly …)을 쓰면서 한쪽 샘플러에만
구현하면, 다른 쪽은 조용히 무시하고 조건에 안 맞는 값을 뽑는다. 그래서 "카드가 선언한 조건"을
샘플러와 독립적으로 다시 확인한다. test/cardContract.test.mjs 가 같은 검사를
JS 샘플러에 한다 — 둘 중 하나를 고치면 다른 쪽도 같이 고칠 것.

    python check_contract.py        시나리오당 20회
    python check_contract.py 50
"""
from __future__ import unicode_literals
import json, os, sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sample_case as sc

# 변주 값 dict 에 쓸 수 있는 키. 여기 없는 키를 카드에 쓰면 두 샘플러 모두에 구현했는지
# 확인하고 이 목록과 cardContract.test.mjs 의 목록에 함께 넣는다.
VALUE_KEYS = {"text", "sexOnly", "occOnly", "minAge", "maxAge", "drinkerOnly", "vitalsShift", "stage"}

HABIT_IDS = {
    "smoking": {"current": ("occasional", "light", "heavy"),
                "ever": ("occasional", "light", "heavy", "ex"),
                "heavy": ("light", "heavy"),
                "notCurrent": ("never", "ex"),
                "never": ("never",)},
    "alcohol": {"drinker": ("social", "heavy"),
                "heavy": ("heavy",),
                "notHeavy": ("none", "social"),
                "never": ("none",)},
}


def allowed(v, p):
    """카드가 값에 건 조건. 샘플러 구현을 쓰지 않고 여기서 다시 적는다."""
    if not isinstance(v, dict):
        return True
    if v.get("sexOnly") and v["sexOnly"] != p["sex"]:
        return False
    want = v.get("occOnly")
    if want:
        ids = set()
        for w in ([want] if isinstance(want, str) else want):
            ids.update(sc.OCC_GROUPS.get(w, (w,)))
        if p["occupation"]["id"] not in ids:
            return False
    if v.get("minAge") is not None and p["age"] < v["minAge"]:
        return False
    if v.get("maxAge") is not None and p["age"] > v["maxAge"]:
        return False
    if v.get("drinkerOnly") and p["alcohol"]["id"] == "none":
        return False
    return True


def text_of(v):
    return v.get("text") if isinstance(v, dict) else v


def check(scen, case, out):
    p, slots, c = case["person"], case["slots"], scen.get("constraints") or {}
    tag = scen["id"]
    lo, hi = c.get("ageRange") or (0, 200)
    if not lo <= p["age"] <= hi:
        out.append("%s: 나이 %d 가 ageRange %s 밖" % (tag, p["age"], c.get("ageRange")))
    if c.get("sex") in ("male", "female") and p["sex"] != c["sex"]:
        out.append("%s: 성별 %s ≠ %s" % (tag, p["sex"], c["sex"]))
    only = c.get("occupationOnly")
    if only and p["occupation"]["id"] not in only:
        out.append("%s: 직업 %s 가 occupationOnly 밖" % (tag, p["occupation"]["id"]))
    if p["illness"]["label"] in (c.get("forbidden") or []):
        out.append("%s: 금지 지병 %s 이 뽑힘" % (tag, p["illness"]["label"]))
    for habit in ("smoking", "alcohol"):
        want = c.get(habit)
        ok = HABIT_IDS[habit].get(want) if want else None
        if ok and p[habit]["id"] not in ok + ("card",):
            out.append("%s: %s %s 가 조건 %s 밖" % (tag, habit, p[habit]["id"], want))

    pools = scen.get("variations") or {}
    for key, pool in pools.items():
        if not isinstance(pool, list) or key not in slots:
            continue
        for v in pool:
            if isinstance(v, dict) and set(v) - VALUE_KEYS:
                out.append("%s: 변주 %s 에 모르는 조건 키 %s" % (tag, key, sorted(set(v) - VALUE_KEYS)))
        if any(allowed(v, p) for v in pool) and not allowed(slots[key], p):
            out.append("%s: 변주 %s 값이 조건 위반 (%s)" % (tag, key, str(text_of(slots[key]))[:24]))

    for group in scen.get("pairedVariations") or []:
        keys = [k for k in group if isinstance(pools.get(k), list)]
        n = min(len(pools[k]) for k in keys) if keys else 0
        usable = [i for i in range(n) if all(allowed(pools[k][i], p) for k in keys)]
        if len(keys) < 2 or not usable:
            continue
        idx = set()
        for k in keys:
            hits = [i for i, v in enumerate(pools[k]) if v == slots.get(k)]
            idx.add(tuple(hits))
        # 같은 값이 여러 자리에 있으면 교집합이 하나라도 있으면 된다
        common = set(range(n))
        for hits in idx:
            common &= set(hits)
        if not common:
            out.append("%s: 짝 %s 가 서로 다른 자리에서 뽑힘" % (tag, "+".join(keys)))

    for opts in (scen.get("ice") or {}).values():
        idea = p["ice"]["idea"]
        for v in opts:
            if isinstance(v, dict) and v.get("text") in idea and not allowed(v, p) and any(allowed(o, p) for o in opts):
                out.append("%s: ICE 값이 조건 위반 (%s)" % (tag, v["text"][:24]))

    g = p.get("guardian")
    if g:
        role = g.get("role")
        rel = role.get("relation") if isinstance(role, dict) else (role or "")
        rel = str(rel or "")
        if "동생" in rel and g["age"] >= p["age"]:
            out.append("%s: 보호자 '%s' %d세가 환자 %d세보다 많음" % (tag, rel, g["age"], p["age"]))
        if any(w in rel for w in ("형", "누나", "언니", "오빠")) and g["age"] <= p["age"]:
            out.append("%s: 보호자 '%s' %d세가 환자 %d세보다 적음" % (tag, rel, g["age"], p["age"]))


def main(argv):
    reps = int(argv[0]) if argv else 20
    found = {}
    total = 0
    for topic, data in sc.topic_files():
        for scen in data["scenarios"]:
            for _ in range(reps):
                case = sc.build(topic, data, scen["id"])
                total += 1
                out = []
                check(scen, case, out)
                for x in out:
                    found.setdefault(x.split(" (")[0], "%s · %s" % (topic, x))
    print("추첨 %d회" % total)
    if not found:
        print("계약 위반 0건")
        return 0
    print("계약 위반 %d종" % len(found))
    for k in sorted(found)[:30]:
        print("   " + found[k])
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

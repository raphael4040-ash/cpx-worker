// 카드 계약 검사 — 카드가 선언한 조건을 JS 샘플러가 실제로 지키는가.  cd cpx-worker && node --test
//
// 추첨 규칙은 cpx-marketplace 의 sample_case.py 와 여기 sampleCase.js 두 곳에 따로 있다.
// 카드에 새 조건을 쓰면서 한쪽에만 구현하면 다른 쪽은 조용히 무시한다. 그래서 카드가 선언한
// 조건을 샘플러와 독립적으로 다시 확인한다. cpx-marketplace/cpx/tools/check_contract.py 가 같은
// 검사를 Python 샘플러에 한다 — 둘 중 하나를 고치면 다른 쪽도 같이 고칠 것.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCase } from "../src/sampleCase.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cases");
const personas = JSON.parse(fs.readFileSync(path.join(DIR, "personas.json"), "utf8"));
const REPS = 15;

// 변주 값 dict 에 쓸 수 있는 키 (check_contract.py VALUE_KEYS 와 같아야 한다).
const VALUE_KEYS = new Set(["text", "sexOnly", "occOnly", "minAge", "maxAge", "drinkerOnly", "vitalsShift", "stage"]);
const OCC_GROUPS = {
  학생: ["student", "highschool", "middleschool", "elementary"],
  사무실: ["office", "teacher", "nurse", "selfemp"],
  현장: ["farmer", "construct", "market", "welder", "cook", "delivery", "driver", "care", "soldier"],
  집: ["housewife", "retired", "jobless"],
};
const HABIT_IDS = {
  smoking: { current: ["occasional", "light", "heavy"], ever: ["occasional", "light", "heavy", "ex"], heavy: ["light", "heavy"], notCurrent: ["never", "ex"], never: ["never"] },
  alcohol: { drinker: ["social", "heavy"], heavy: ["heavy"], notHeavy: ["none", "social"], never: ["none"] },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function allowed(v, p) {
  if (!isObj(v)) return true;
  if (v.sexOnly && v.sexOnly !== p.sex) return false;
  if (v.occOnly) {
    const ids = new Set();
    for (const w of Array.isArray(v.occOnly) ? v.occOnly : [v.occOnly]) for (const id of OCC_GROUPS[w] || [w]) ids.add(id);
    if (!ids.has(p.occupation.id)) return false;
  }
  if (v.minAge != null && p.age < v.minAge) return false;
  if (v.maxAge != null && p.age > v.maxAge) return false;
  if (v.drinkerOnly && p.alcohol.id === "none") return false;
  return true;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(scen, kase, out) {
  const p = kase.person, slots = kase.slots, c = scen.constraints || {}, tag = scen.id;
  const [lo, hi] = c.ageRange || [0, 200];
  if (p.age < lo || p.age > hi) out.push(`${tag}: 나이 ${p.age} 가 ageRange 밖`);
  if ((c.sex === "male" || c.sex === "female") && p.sex !== c.sex) out.push(`${tag}: 성별 ${p.sex} ≠ ${c.sex}`);
  if (c.occupationOnly && !c.occupationOnly.includes(p.occupation.id)) out.push(`${tag}: 직업 ${p.occupation.id} 가 occupationOnly 밖`);
  if ((c.forbidden || []).includes(p.illness.label)) out.push(`${tag}: 금지 지병 ${p.illness.label}`);
  for (const habit of ["smoking", "alcohol"]) {
    const ok = c[habit] && HABIT_IDS[habit][c[habit]];
    if (ok && ![...ok, "card"].includes(p[habit].id)) out.push(`${tag}: ${habit} ${p[habit].id} 가 조건 ${c[habit]} 밖`);
  }
  const pools = scen.variations || {};
  for (const [key, pool] of Object.entries(pools)) {
    if (!Array.isArray(pool) || !(key in slots)) continue;
    for (const v of pool) {
      if (isObj(v)) {
        const extra = Object.keys(v).filter((k) => !VALUE_KEYS.has(k));
        if (extra.length) out.push(`${tag}: 변주 ${key} 에 모르는 조건 키 ${extra}`);
      }
    }
    if (pool.some((v) => allowed(v, p)) && !allowed(slots[key], p)) out.push(`${tag}: 변주 ${key} 값이 조건 위반`);
  }
  for (const group of scen.pairedVariations || []) {
    const keys = group.filter((k) => Array.isArray(pools[k]));
    if (keys.length < 2) continue;
    const n = Math.min(...keys.map((k) => pools[k].length));
    const usable = [...Array(n).keys()].filter((i) => keys.every((k) => allowed(pools[k][i], p)));
    if (!usable.length) continue;
    let common = new Set([...Array(n).keys()]);
    for (const k of keys) {
      const hits = new Set(pools[k].map((v, i) => (same(v, slots[k]) ? i : -1)).filter((i) => i >= 0));
      common = new Set([...common].filter((i) => hits.has(i)));
    }
    if (!common.size) out.push(`${tag}: 짝 ${keys.join("+")} 가 서로 다른 자리에서 뽑힘`);
  }
  for (const opts of Object.values(scen.ice || {})) {
    for (const v of opts) {
      if (isObj(v) && p.ice.idea.includes(v.text) && !allowed(v, p) && opts.some((o) => allowed(o, p))) out.push(`${tag}: ICE 값이 조건 위반`);
    }
  }
  const g = p.guardian;
  if (g) {
    const rel = String((isObj(g.role) ? g.role.relation : g.role) || "");
    if (rel.includes("동생") && g.age >= p.age) out.push(`${tag}: 보호자 '${rel}'가 환자보다 나이 많음`);
    if (["형", "누나", "언니", "오빠"].some((w) => rel.includes(w)) && g.age <= p.age) out.push(`${tag}: 보호자 '${rel}'가 환자보다 어림`);
  }
}

test("JS 샘플러가 카드가 선언한 조건을 모두 지킨다", () => {
  const found = new Set();
  for (const f of fs.readdirSync(DIR).filter((x) => /^\d.*\.json$/.test(x))) {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    for (const scen of data.scenarios) {
      for (let i = 0; i < REPS; i++) {
        const out = [];
        check(scen, buildCase(f.replace(/\.json$/, ""), data, personas, scen.id), out);
        for (const x of out) found.add(`${f} · ${x}`);
      }
    }
  }
  assert.deepEqual([...found].sort().slice(0, 20), []);
});

// 카드 소견 값에 작성자용 메모가 섞였는지 전 카드를 훑는다.  cd cpx-worker && node --test
// 서버가 진찰 소견을 값 그대로 읽어 주는 방식이라(peMatch.js), 메모가 있으면 학생에게 그대로 보인다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../src/cases/", import.meta.url);
const NOTE = /(맞춘다|맞춰|뽑은|슬롯|채운다|채워|작성자|프롬프트|\{\{)/;

function* values(o, path) {
  if (typeof o === "string") yield [path, o];
  else if (Array.isArray(o)) for (const [i, v] of o.entries()) yield* values(v, `${path}[${i}]`);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) yield* values(v, `${path}.${k}`);
}

test("모든 카드의 진찰 소견 값에 작성자 메모가 없다 (슬롯 {{…}} 은 추첨에서 채워지므로 제외)", () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json") && !/^(index|personas)\.json$/.test(n))) {
    const card = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
    (card.scenarios || []).forEach((s, i) => {
      for (const [p, v] of values((s.pe || {}).findings || {}, `${f}#${i}`)) {
        const text = v.replace(/\{\{[^}]*\}\}/g, "");
        if (NOTE.test(text)) bad.push(`${p}: ${v.slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

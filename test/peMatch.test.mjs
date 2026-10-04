// 진찰 단계를 모델 없이 답하는 매칭 테스트.  cd cpx-worker && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFindings, vitalsReply, findingsReply } from "../src/peMatch.js";

const F = {
  "전신 외관": "아파 보인다",
  "복부 시진": "팽만 없음",
  "복부 청진": "장음 감소",
  "복부 촉진": "우하복부 압통",
  "반발통": "우하복부 양성",
  "늑골척추각 압통": "없음",
  "심음 청진": "규칙적",
  "폐음 청진": "정상",
  "하지": "부종 없음, 종아리 압통 없음",
  "Murphy 징후": "음성",
};
const keys = (m) => (m ? m.map((x) => x.key) : null);

test("진찰 동작과 부위가 맞는 소견 하나만 고른다", () => {
  assert.deepEqual(keys(matchFindings("배를 눌러볼게요.", F)), ["복부 촉진"]);
  assert.deepEqual(keys(matchFindings("배 소리 들어보겠습니다.", F)), ["복부 청진"]);
  assert.deepEqual(keys(matchFindings("심장 소리 들어볼게요", F)), ["심음 청진"]);
  assert.deepEqual(keys(matchFindings("(폐 청진)", F)), ["폐음 청진"]);
  assert.deepEqual(keys(matchFindings("등 두드려 볼게요", F)), ["늑골척추각 압통"]);
});

test("소견 이름을 그대로 말하면 그 소견", () => {
  assert.deepEqual(keys(matchFindings("Murphy 징후 확인하겠습니다", F)), ["Murphy 징후"]);
});

test("허락을 구하는 말, 애매한 말, 부위 전체 칸은 모델에 넘긴다", () => {
  assert.equal(matchFindings("배 좀 눌러봐도 될까요?", F), null);
  assert.equal(matchFindings("진찰 시작하겠습니다", F), null);
  assert.equal(matchFindings("다리 볼게요", F), null); // "하지" 한 칸에 여러 진찰 결과가 들어 있다
  assert.equal(matchFindings("전체적으로 살펴볼게요", F), null);
});

test("활력징후 응답과 양팔 혈압 차이 숫자 채우기", () => {
  const v = { sbp: 120, dbp: 80, hr: 78, rr: 16, temp: 36.8, spo2: 98, armDiff: 32 };
  assert.equal(vitalsReply(v), "(혈압 120/80 mmHg, 맥박 78회/분, 호흡 16회/분, 체온 36.8℃, 산소포화도 98%)");
  assert.equal(vitalsReply({}), null);
  const r = findingsReply([{ key: "양팔 혈압", text: "우측 수축기 혈압이 좌측보다 뚜렷하게 낮다(차이는 활력징후의 양팔 수축기압 차이 값)" }], v);
  assert.match(r, /차이 32 mmHg/);
});

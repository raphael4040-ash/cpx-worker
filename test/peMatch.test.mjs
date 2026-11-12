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

// 발열 케이스(18-fever)의 실제 소견 이름. 목구멍 시진 + 폐 청진을 한 문장에 요청하면 폐음만 나오던 문제.
const FEVER = {
  "전신 외관": "아파 보인다",
  "늑골척추각 압통": "오른쪽에서 두드리면 심한 통증",
  "복부 촉진": "하복부에 경한 압통",
  "복부 청진": "장음 정상",
  "폐음 청진": "양측 정상",
  "심음 청진": "규칙적",
  "인후 시진": "정상",
  "경부 림프절": "커진 것 없음",
};

const sorted = (m) => keys(m).sort();

test("한 문장에 부위를 여럿 말하면 각각의 소견을 모두 준다", () => {
  assert.deepEqual(sorted(matchFindings("(입을 벌리게 하고 목구멍을 시진하고, 양쪽 폐를 청진한다)", FEVER)), ["인후 시진", "폐음 청진"]);
  assert.deepEqual(sorted(matchFindings("심장 소리와 폐 소리를 들어보겠습니다", FEVER)), ["심음 청진", "폐음 청진"]);
});

test("청진과 같이 말해도 시진은 지워지지 않고, 목구멍 시진 하나만 말해도 그대로 맞는다", () => {
  assert.deepEqual(keys(matchFindings("(목구멍을 시진한다)", FEVER)), ["인후 시진"]);
  assert.deepEqual(keys(matchFindings("(폐를 청진한다)", FEVER)), ["폐음 청진"]);
});

test("소견에 없는 진찰이 같이 섞이면 일부만 답하지 않고 모델에 넘긴다", () => {
  assert.equal(matchFindings("(폐를 청진하고 무릎 반사를 확인한다)", FEVER), null);
  assert.equal(matchFindings("(폐를 청진하고 갑상선을 촉진한다)", FEVER), null);
});

test("다른 동작 낱말이 없을 때의 '볼게요'만 시진으로 본다", () => {
  assert.deepEqual(keys(matchFindings("목구멍 좀 볼게요", FEVER)), ["인후 시진"]);
  // 청진 동작이 같이 있으면 "볼게요"는 시진이 아니다 — 목구멍 소견이 안 맞으니 일부만 답하지 않고 모델에 넘긴다.
  assert.equal(matchFindings("폐 소리 들어볼게요 그리고 목구멍도 볼게요", FEVER), null);
});

test("소견 값 끝의 작성자 메모 괄호는 학생에게 읽어 주지 않는다", () => {
  const m = [{ key: "양팔 혈압", text: "좌우 차이 없음(수축기압 차이 10 미만, 수치는 뽑은 활력징후에 맞춘다)" }];
  assert.equal(findingsReply(m, {}), "(양팔 혈압: 좌우 차이 없음)");
  // 환자에게 보여야 하는 괄호(수치·설명)는 그대로 둔다
  assert.equal(findingsReply([{ key: "복부 촉진", text: "하복부에 경한 압통(반발통 없음)" }], {}), "(복부 촉진: 하복부에 경한 압통(반발통 없음))");
  // 대동맥박리의 양팔 혈압 차이는 숫자를 채운 뒤에도 메모가 남지 않는다
  const dis = [{ key: "양팔 혈압", text: "우측 수축기 혈압이 좌측보다 뚜렷하게 낮다(차이는 활력징후의 양팔 수축기압 차이 값)" }];
  assert.equal(findingsReply(dis, { armDiff: 32 }), "(양팔 혈압: 우측 수축기 혈압이 좌측보다 뚜렷하게 낮다(차이 32 mmHg))");
});

test("자궁과 부속기를 같이 촉진했다면 부속기만 답하지 않고 모델에 넘긴다 (자궁 소견이 사라지던 문제)", () => {
  const PELVIC = {
    "골반 진찰(질경)": "자궁경부는 매끈하다",
    "골반 진찰(양손 진찰)": "자궁이 약간 크고 부드럽다",
    "부속기": "양측 종괴나 압통 없음",
    "자궁경부 운동 압통": "없음",
  };
  assert.equal(matchFindings("양손으로 자궁과 부속기를 촉진하겠습니다.", PELVIC), null);
  assert.equal(matchFindings("자궁을 촉진하겠습니다.", PELVIC), null);
  // 부속기만 말하면 지금처럼 바로 답한다
  assert.deepEqual(keys(matchFindings("부속기를 촉진하겠습니다.", PELVIC)), ["부속기"]);
  // 골반 진찰이라고만 하면 두 소견을 다 준다
  assert.deepEqual(keys(matchFindings("골반 진찰을 하겠습니다.", PELVIC)).sort(), ["골반 진찰(양손 진찰)", "골반 진찰(질경)"].sort());
  // 자궁경부 운동 압통은 직접 이름으로 맞는다
  assert.deepEqual(keys(matchFindings("자궁경부 운동 압통이 있는지 확인하겠습니다.", PELVIC)), ["자궁경부 운동 압통"]);
});

test("산전 진찰의 자궁저 높이는 새 사전에 걸리지 않는다", () => {
  const OB = { "자궁저 높이": "배꼽 위 두 손가락", "태아 심음": "분당 140회" };
  assert.deepEqual(keys(matchFindings("자궁저 높이를 재겠습니다.", OB)), ["자궁저 높이"]);
});

// ---- 2026-11-12 전 카드 진찰 매칭 점검에서 나온 것 ----
{
  const { readFileSync } = await import("node:fs");
  const { matchFindings: mf } = await import("../src/peMatch.js");
  const card = (f) => JSON.parse(readFileSync(new URL(`../src/cases/${f}.json`, import.meta.url), "utf8"));
  const fnd = (f, id) => card(f).scenarios.find((s) => s.id === id).pe.findings;
  const keys = (r) => (r ? r.map((x) => x.key) : null);

  test("유방덩이: '유방을 촉진'에 반대쪽 정상 소견만 돌려주지 않는다 (덩이 소견은 다른 이름이라 모델에 넘긴다)", () => {
    for (const id of ["bm-fibroadenoma", "bm-cancer", "bm-abscess"]) {
      assert.equal(mf("유방을 촉진하겠습니다.", fnd("34-2-breast-mass", id)), null, id);
      // 반대쪽을 짚어 말하면 그 소견을 준다
      assert.deepEqual(keys(mf("반대쪽 유방도 촉진하겠습니다.", fnd("34-2-breast-mass", id))), ["유방 촉진(반대쪽)"], id);
    }
    // 환측·반대쪽이 둘 다 있는 카드는 그대로 둘 다 준다
    assert.deepEqual(keys(mf("유방을 촉진하겠습니다.", fnd("34-1-breast-pain", "bp-cancer"))), ["유방 촉진(환측)", "유방 촉진(반대쪽)"]);
  });

  test("손목·발목·목소리는 목 진찰이 아니다", () => {
    const f = { "목 시진": "정상", "경부 림프절": "없음", "팔·손목 시진": "흉터 없음" };
    assert.equal(mf("손목을 움직여 보겠습니다.", f), null);
    assert.equal(mf("발목을 만져보겠습니다.", f), null);
    assert.deepEqual(keys(mf("팔·손목 시진 확인하겠습니다.", f)), ["팔·손목 시진"]);
    assert.deepEqual(keys(mf("목을 시진하겠습니다.", f)), ["목 시진"]);
  });

  test("반발통: 손을 떼는 동작만 — '청진기를 떼겠습니다'는 아니고, '손을 뗄 때'는 맞다", () => {
    const f = { "복부 시진": "편평", "복부 촉진": "우하복부 압통", "반발통": "있음" };
    assert.equal(mf("청진기를 떼겠습니다.", f), null);
    assert.deepEqual(keys(mf("배에서 손을 뗄 때 아픈지 보겠습니다.", f)), ["반발통"]);
    assert.deepEqual(keys(mf("반발통이 있는지 확인하겠습니다.", f)), ["반발통"]);
  });

  test("'힘을 빼세요'·'힘드시면'은 근력 검사가 아니다", () => {
    const f = { "하지 근력": "정상", "복부 촉진": "부드러움" };
    assert.equal(mf("힘을 빼고 편하게 계세요.", f), null);
    assert.equal(mf("힘드시면 말씀하세요", f), null);
    assert.deepEqual(keys(mf("다리 힘을 확인하겠습니다.", f)), ["하지 근력"]);
  });

  test("청력 확인은 이경검사가 아니다", () => {
    const f = { "이경검사": "고막 정상" };
    assert.equal(mf("귀가 잘 들리는지 확인하겠습니다.", f), null);
    assert.deepEqual(keys(mf("귀를 들여다보겠습니다.", f)), ["이경검사"]);
  });

  test("태아 심음을 들으면 산모의 심장 청진 소견이 딸려 나오지 않는다", () => {
    for (const id of ["pre-normal-2nd", "pre-preeclampsia", "pre-gdm"]) {
      assert.deepEqual(keys(mf("태아 심음을 들어보겠습니다.", fnd("24-prenatal-care", id))), ["태아 심음"], id);
    }
    assert.deepEqual(keys(mf("심장 소리를 들어보겠습니다.", fnd("24-prenatal-care", "pre-normal-2nd"))), ["심장 청진"]);
  });
}

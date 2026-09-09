/**
 * 웹 면담용 케이스 조합 라우트.
 *
 * Cloudflare Worker에서 Gemini API로 나가는 요청이 구글 쪽 지역 차단
 * ("User location is not supported for the API use")에 걸리는 게 확인돼서,
 * 실제 Gemini 호출은 브라우저가 직접 한다 (Worker → Google 경로가 막혀도
 * 학생 브라우저 → Google 경로는 막히지 않는다). 이 Worker는 케이스를 뽑고
 * 시스템 프롬프트를 만들어 돌려주는 역할만 한다.
 *
 * 케이스 정답(dx·PE 소견)이 브라우저에 내려간다는 뜻이다. 다만 이 저장소
 * (cpx-worker) 자체가 이미 공개 GitHub 레포라 케이스 JSON은 어차피 공개돼
 * 있었다 — UI에 안 보이게 하는 것 이상의 은닉은 애초에 없었다.
 */
import { buildCase, caseToPrompt } from "./sampleCase.js";
import { buildSystemPrompt } from "./interviewPrompt.js";
import indexData from "./cases/index.json";
import personas from "./cases/personas.json";
import { CASES } from "./cases/manifest.js";

const DEFAULT_MODEL = "gemini-flash-latest";

// 물질오남용·자살·성폭력·가정폭력 같은 카드는 임상 실습 목적의 정상적인 대화인데도
// 기본 안전 임계값에 걸려 응답이 통째로 비는 경우가 있었다. 명백히 고위험(HIGH)인
// 것만 막는다. 브라우저가 Gemini 를 직접 호출하므로 이 설정도 함께 내려준다.
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

export async function handleInterviewStart(request, env, cors) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* 빈 바디 허용 — 무작위 케이스 */
  }

  const resolved = resolveTopic(body.topic);
  if (!resolved) {
    return json({ error: "unknown_topic", hint: "topics.js 의 표기와 일치해야 합니다" }, 400, cors);
  }
  if (resolved._procedureCase || resolved._noPhysicalExam) {
    // 술기 카드(situation·expectedSequence·distractors)와 "나쁜 소식 전하기"
    // (awareness·news·reactionStages)는 일반 hpi/redFlags/pe 스키마와 전혀 달라서
    // 이 프롬프트 빌더가 아직 다루지 않는다. 지금은 Claude Code 플러그인 전용으로
    // 남겨두고, 웹 면담에서는 명시적으로 막는다.
    return json({ error: "topic_not_supported", hint: "이 케이스는 아직 웹 면담에서 지원하지 않습니다" }, 400, cors);
  }

  const fileKey = resolved.file.replace(/\.json$/, "");
  const data = CASES[fileKey];
  if (!data) return json({ error: "case_not_bundled", file: resolved.file }, 500, cors);

  const kase = buildCase(fileKey, data, personas);
  if (kase.problems && kase.problems.length) {
    console.log("case build problems:", resolved.topicName, kase.problems);
  }
  const resolvedCase = caseToPrompt(kase);
  const systemPrompt = buildSystemPrompt(resolvedCase, {
    noPE: !!resolved._noPhysicalExam,
    procedure: !!resolved._procedureCase,
  });

  return json(
    {
      topic: resolvedCase.topic,
      systemPrompt,
      model: env.GEMINI_MODEL || DEFAULT_MODEL,
      safetySettings: SAFETY_SETTINGS,
    },
    200,
    cors
  );
}

// ---------------------------------------------------------------- helpers

/** topic 이 비어 있으면 무작위, 있으면 index.json 의 aliases 를 거쳐 찾는다. */
function resolveTopic(input) {
  const topics = indexData.topics;
  if (!input) {
    // 술기 카드·나쁜 소식 전하기는 무작위 풀에서도 뺀다 (아래 topic_not_supported 안내 참고).
    const keys = Object.keys(topics).filter((k) => !topics[k]._procedureCase && !topics[k]._noPhysicalExam);
    const name = keys[Math.floor(Math.random() * keys.length)];
    return { topicName: name, ...topics[name] };
  }
  const canonical = topics[input] ? input : indexData.aliases[input];
  if (!canonical || !topics[canonical]) return null;
  return { topicName: canonical, ...topics[canonical] };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

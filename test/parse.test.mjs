// 워커의 파싱 로직 테스트.  Node 설치 후 아래로 실행하세요.
//   cd cpx-worker && node --test
//
// worker.js 는 Cloudflare 런타임용이라 export default 하나만 내보내므로,
// 검증 대상 순수 함수는 여기에 동일 구현을 두고 함께 관리합니다.
// worker.js 를 고치면 이 파일도 같이 고쳐야 합니다.
import { test } from "node:test";
import assert from "node:assert/strict";

function parseRecordBlock(text) {
  const m = text.match(/```cpx-record\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    return typeof obj === "object" && obj ? obj : null;
  } catch {
    return null;
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function hasToolBlock(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && (b.type === "tool_use" || b.type === "tool_result")
  );
}

const NOISE_TAGS =
  /<(system-reminder|command-message|command-name|command-args|command-contents|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const END_SIGNAL = /^평가[\s.!]*$/;
const NOISE_LINES = /^\[(Request interrupted|No response requested)[^\]]*\]$/;

function cleanText(s) {
  const stripped = String(s ?? "")
    .replace(NOISE_TAGS, "")
    .replace(/<\/?(system-reminder|command-[a-z]+)>/g, "")
    .trim();
  return NOISE_LINES.test(stripped) ? "" : stripped;
}

function renderTranscript(jsonl) {
  let cur = [];
  let done = null;
  let closed = false;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;
    if (entry.toolUseResult !== undefined) continue;

    const msg = entry.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (hasToolBlock(msg.content)) continue;

    const raw = extractText(msg.content);
    if (/<command-name>\s*\/cpx:/.test(raw)) {
      cur = [];
      done = null;
      closed = false;
      continue;
    }

    const text = cleanText(raw);
    if (!text) continue;
    if (
      text.includes("```cpx-record") ||
      (msg.role === "user" && END_SIGNAL.test(text))
    ) {
      if (!closed) {
        done = cur;
        cur = [];
        closed = true;
      }
      continue;
    }
    if (closed) continue;

    cur.push(`${msg.role === "user" ? "의사" : "환자"}: ${text}`);
  }
  return (done || cur).join("\n\n");
}

const RATE_LIMIT_WINDOW_SEC = 600;
const RATE_LIMIT_MAX = 20;

async function checkRateLimit(kv, ip) {
  if (!kv || !ip) return true;
  const key = `iv:${ip}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return true;
  }
  if (count >= RATE_LIMIT_MAX) return false;
  try {
    await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
  } catch {
    /* 카운트 저장에 실패해도 이번 요청은 이미 허용됐다 */
  }
  return true;
}

// 실제 KV 를 흉내내는 인메모리 가짜.
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function decodePairingToken(token) {
  const norm = token.replace(/-/g, "+").replace(/_/g, "/");
  const parsed = JSON.parse(Buffer.from(norm, "base64").toString("utf8"));
  if (parsed.v !== 1 || !parsed.rt) throw new Error("unsupported token");
  return parsed;
}

// 실제 Claude Code .jsonl 의 엔트리 모양을 흉내낸 헬퍼들.
const cmd = (name, args) =>
  JSON.stringify({
    type: "user",
    isSidechain: false,
    message: {
      role: "user",
      content:
        `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>` +
        (args ? `\n<command-args>${args}</command-args>` : ""),
    },
  });
const skillBody = (body) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: [{ type: "text", text: body }] },
  });
const say = (role, text) =>
  JSON.stringify({
    type: role === "user" ? "user" : "assistant",
    isSidechain: false,
    message: { role, content: [{ type: "text", text }] },
  });

// ---------------------------------------------------------------

test("평가 메시지에서 기록 블록을 뽑는다", () => {
  const msg = [
    "## 채점 결과",
    "총점 78 / 100 (B)",
    "",
    "```cpx-record",
    '{"topic":"가슴통증","total":78,"history":45,"pe":16,"ppi":17,"grade":"B","summary":"ICE 누락"}',
    "```",
  ].join("\n");
  const r = parseRecordBlock(msg);
  assert.equal(r.total, 78);
  assert.equal(r.topic, "가슴통증");
  assert.equal(r.grade, "B");
});

test("문진 중 메시지는 무시한다 (업로드 안 됨)", () => {
  assert.equal(parseRecordBlock("가슴이 답답하고 아파요..."), null);
});

test("블록이 깨져 있으면 무시한다", () => {
  assert.equal(parseRecordBlock("```cpx-record\n{broken,,}\n```"), null);
});

test("일부 키가 없어도 받아들인다", () => {
  const r = parseRecordBlock('```cpx-record\n{"topic":"두통","total":62}\n```');
  assert.equal(r.total, 62);
  assert.equal(r.pe, undefined);
});

test("전사에서 도구호출과 깨진 줄을 걸러낸다", () => {
  const jsonl = [
    say("user", "어디가 불편하세요?"),
    say("assistant", "가슴이 답답해요"),
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"어떤 케이스로 갈까"}]}}',
    '{"type":"user","toolUseResult":{"stdout":""},"message":{"role":"user","content":[{"type":"tool_result","content":"파일 내용"}]}}',
    '{"type":"attachment","attachment":{"type":"file"}}',
    "ail-cut-off-first-line",
    say("user", "진찰"),
    '{"type":"summary","summary":"..."}',
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.equal(rendered.split("\n\n").length, 3);
  assert.ok(rendered.startsWith("의사: 어디가 불편하세요?"));
  assert.ok(rendered.includes("환자: 가슴이 답답해요"));
  assert.ok(!rendered.includes("파일 내용"));
  assert.ok(!rendered.includes("어떤 케이스로 갈까"));
});

test("슬래시 명령 줄과 주입된 SKILL.md 본문은 전사에 남지 않는다", () => {
  const jsonl = [
    cmd("/cpx:start", "어지럼"),
    skillBody("Base directory for this skill: C:\\Users\\x\n# CPX/OSCE 모의 표준화 환자 시뮬레이터\n## 절대 규칙\n..."),
    say("assistant", "제가 어지러워서 왔어요."),
    say("user", "언제부터 그러셨어요?"),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("command-name"));
  assert.ok(!rendered.includes("절대 규칙"));
  assert.ok(!rendered.includes("Base directory"));
  assert.equal(
    rendered,
    "환자: 제가 어지러워서 왔어요.\n\n의사: 언제부터 그러셨어요?"
  );
});

test("채점 메시지는 전사에서 빠진다 (채점 결과 탭에 따로 저장됨)", () => {
  const jsonl = [
    say("assistant", "머리가 아파요."),
    say("user", "평가"),
    say(
      "assistant",
      '## I. 병력청취 — 0 / 60\n...\n```cpx-record\n{"topic":"어지럼","total":0}\n```'
    ),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("병력청취"));
  assert.ok(!rendered.includes("cpx-record"));
  // 면담을 끝내려고 친 `평가` 신호도 면담 내용이 아니므로 빠진다.
  assert.equal(rendered, "환자: 머리가 아파요.");
});

test("`진찰` 은 남기고 `평가` 만 버린다", () => {
  const jsonl = [
    say("user", "어디가 불편하세요?"),
    say("assistant", "배가 아파요."),
    say("user", "진찰"),
    say("assistant", "(혈압 120/80, 맥박 88회/분입니다.)"),
    say("user", "평가"),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(rendered.includes("의사: 진찰"), "진찰 은 단계 구분으로 남아야 한다");
  assert.ok(!/의사: 평가/.test(rendered));
  assert.ok(rendered.endsWith("(혈압 120/80, 맥박 88회/분입니다.)"));
});

test("한 세션에서 두 케이스를 돌리면 마지막 케이스만 남는다", () => {
  const jsonl = [
    cmd("/cpx:start"),
    say("assistant", "첫 번째 케이스 환자입니다."),
    say("user", "평가"),
    say("assistant", '채점...\n```cpx-record\n{"topic":"두통","total":50}\n```'),
    cmd("/cpx:start"),
    say("assistant", "두 번째 케이스 환자입니다."),
    say("user", "어디가 불편하세요?"),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("첫 번째"));
  assert.ok(rendered.startsWith("환자: 두 번째 케이스 환자입니다."));
});

test("채점 뒤에 이어간 대화는 전사에 들어가지 않는다", () => {
  const jsonl = [
    cmd("/cpx:start", "어지럼"),
    say("assistant", "어지러워서 왔어요."),
    say("user", "언제부터 그러셨어요?"),
    say("assistant", "사흘 됐어요."),
    say("user", "평가"),
    say(
      "assistant",
      '## I. 병력청취 — 20 / 60\n...\n```cpx-record\n{"topic":"어지럼","total":30}\n```'
    ),
    say("user", "ICE는 왜 감점이야?"),
    say("assistant", "환자의 걱정을 묻지 않으셨습니다."),
    say("user", "다음엔 뭘 먼저 물어야 해?"),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("감점"), "채점 뒤 대화는 면담이 아니다");
  assert.equal(
    rendered,
    "환자: 어지러워서 왔어요.\n\n의사: 언제부터 그러셨어요?\n\n환자: 사흘 됐어요."
  );
});

test("같은 세션에서 기록이 또 올라가도 면담만 남는다", () => {
  // 채점 뒤 대화 끝에 기록 블록이 한 번 더 나오면 업로드가 또 일어난다.
  // 그때 올라가는 전사도 면담이어야지 채점 뒤 대화여서는 안 된다.
  const jsonl = [
    cmd("/cpx:start"),
    say("assistant", "배가 아파요."),
    say("user", "언제부터 그러셨어요?"),
    say("user", "평가"),
    say("assistant", '채점...\n```cpx-record\n{"topic":"복통","total":40}\n```'),
    say("user", "이 항목은 인정해주고 다시 매겨줘"),
    say("assistant", '다시 채점...\n```cpx-record\n{"topic":"복통","total":45}\n```'),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("인정해주고"));
  assert.equal(rendered, "환자: 배가 아파요.\n\n의사: 언제부터 그러셨어요?");
});

test("system-reminder 와 클라이언트 안내 줄을 걷어낸다", () => {
  const jsonl = [
    say(
      "user",
      "<system-reminder>이건 배경 정보입니다</system-reminder>\n언제부터 아프셨어요?"
    ),
    say("user", "[Request interrupted by user]"),
    say("assistant", "어제 저녁부터요."),
  ].join("\n");
  const rendered = renderTranscript(jsonl);
  assert.ok(!rendered.includes("배경 정보"));
  assert.ok(!rendered.includes("Request interrupted"));
  assert.equal(
    rendered,
    "의사: 언제부터 아프셨어요?\n\n환자: 어제 저녁부터요."
  );
});

test("페어링 토큰 왕복", () => {
  const payload = { v: 1, uid: "abc123", rt: "AMf-vBy_LONG-token", tv: 2 };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  assert.ok(!/[+/]/.test(b64), "base64url 이어야 URL·헤더에서 깨지지 않는다");
  const back = decodePairingToken(b64);
  assert.deepEqual(back, payload);
});

test("잘못된 토큰은 예외를 던진다", () => {
  assert.throws(() => decodePairingToken("not-a-token"));
});

test("KV 바인딩이 없으면 레이트리밋 없이 통과한다", async () => {
  assert.equal(await checkRateLimit(null, "1.2.3.4"), true);
});

test("IP 를 못 얻으면 통과한다 (막는 것보다 여는 쪽이 안전)", async () => {
  assert.equal(await checkRateLimit(fakeKv(), ""), true);
});

test("한도 안에서는 통과하고 카운트가 쌓인다", async () => {
  const kv = fakeKv();
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    assert.equal(await checkRateLimit(kv, "9.9.9.9"), true);
  }
  assert.equal(await kv.get("iv:9.9.9.9"), String(RATE_LIMIT_MAX));
});

test("한도를 넘으면 막는다", async () => {
  const kv = fakeKv({ "iv:5.5.5.5": String(RATE_LIMIT_MAX) });
  assert.equal(await checkRateLimit(kv, "5.5.5.5"), false);
});

test("IP 가 다르면 서로 카운트에 영향 없다", async () => {
  const kv = fakeKv({ "iv:1.1.1.1": String(RATE_LIMIT_MAX) });
  assert.equal(await checkRateLimit(kv, "2.2.2.2"), true);
});

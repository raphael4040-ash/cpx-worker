/**
 * CPX 업로드 중계 워커 (Cloudflare Workers)
 *
 * 이 워커는 자격증명을 하나도 보관하지 않는다. 클라이언트가 보낸 페어링 토큰 안에
 * 들어있는 Firebase refresh token 으로 ID token 을 발급받아, "그 유저 본인 자격"으로
 * Firestore 에 기록을 쓴다. 따라서 기존 firestore.rules 의 uid 검증이 그대로 적용된다.
 *
 * 하는 일:
 *   1. 페어링 토큰 검증 및 ID token 교환
 *   2. Claude Code Stop 훅 페이로드에서 ```cpx-record 블록 파싱
 *   3. (동의한 경우) 전사 JSONL 에서 면담 부분만 골라 평문으로 변환
 *   4. Firestore REST 로 records 문서 생성
 */
import { handleInterviewStart } from "./interviewRoutes.js";

// Cloudflare 대시보드에서 환경변수(FIREBASE_PROJECT_ID / FIREBASE_API_KEY)를 넣으면
// 그 값이 우선하고, 안 넣으면 아래 기본값을 쓴다. 둘 다 웹앱에 그대로 노출되는
// 공개 식별자라 코드에 박아둬도 안전하다 — 접근 통제는 firestore.rules 가 한다.
const DEFAULT_PROJECT_ID = "cpx-tracker";
const DEFAULT_API_KEY = "AIzaSyD1rN6_CvmmjvV40kRGD37f7TZ2ZwNZpqA";

// 기록판 주인(관리자)의 uid. firestore.rules 의 ownerUid() 와 반드시 같아야 한다.
// 관리자는 승인 절차 없이 항상 쓸 수 있다.
const DEFAULT_OWNER_UID = "S4b2Zqzff2XHNznL1Wcq6RiZVGv1";

// 배포된 워커가 최신인지 밖에서 확인하기 위한 버전 문자열.
// 이 파일을 고칠 때마다 함께 올린다 — 그래야 `curl .../health` 로 붙었는지 판별된다.
const WORKER_VERSION = "2026-09-09.1";

const MAX_TRANSCRIPT_CHARS = 700000; // Firestore 문서 상한 1MiB 대비 여유
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// /interview/start 는 로그인·페어링 토큰이 필요 없다 — 학생 브라우저가 세션을
// 시작하기 전부터 부르는 경로라서다. 그만큼 인증 없이 열려 있어, 외부에서 스크립트로
// 반복 호출하면 Cloudflare 무료 한도(하루 10만 요청)를 실제 학생 몫까지 갉아먹을 수 있다.
// env.RATE_LIMIT_KV 가 설정돼 있을 때만 IP 당 창 하나에 요청 수를 센다 — KV 바인딩을
// 아직 안 만든 배포(로컬 dev 등)에서는 그냥 통과시킨다(가용성을 우선한다).
const RATE_LIMIT_WINDOW_SEC = 600; // 10분
const RATE_LIMIT_MAX = 20; // 창 하나당 IP 당 허용 요청 수 — 정상적인 면담 시작 재시도는 넉넉히 통과한다

async function checkRateLimit(kv, ip) {
  if (!kv || !ip) return true;
  const key = `iv:${ip}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return true; // KV 읽기 실패로 정상 사용자를 막지 않는다
  }
  if (count >= RATE_LIMIT_MAX) return false;
  try {
    await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
  } catch {
    /* 카운트 저장에 실패해도 이번 요청은 이미 허용됐다 */
  }
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, version: WORKER_VERSION });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    try {
      if (url.pathname === "/upload") return await handleUpload(request, env);
      // 웹 면담 — 케이스 조합·프롬프트 생성만 여기서 하고, 실제 Gemini 호출은 브라우저가
      // 직접 한다(Worker→Google 경로가 구글 지역 차단에 걸려서). 별도 파일(interviewRoutes.js).
      if (url.pathname === "/interview/start") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        const allowed = await checkRateLimit(env.RATE_LIMIT_KV, ip);
        if (!allowed) {
          return json({ error: "rate_limited", hint: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
        }
        return await handleInterviewStart(request, env, CORS);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      // 훅은 non-2xx 를 non-blocking error 로 취급하므로 세션을 막지 않는다.
      return json({ error: "internal", detail: String(err && err.message || err) }, 500);
    }
  },
};

async function handleUpload(request, env) {
  const cfg = {
    projectId: env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID,
    apiKey: env.FIREBASE_API_KEY || DEFAULT_API_KEY,
    ownerUid: env.OWNER_UID || DEFAULT_OWNER_UID,
  };

  const auth = request.headers.get("Authorization") || "";
  const pairing = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!pairing) return json({ error: "missing_token" }, 401);

  let creds;
  try {
    creds = decodePairingToken(pairing);
  } catch {
    return json({ error: "bad_token" }, 401);
  }

  const form = await request.formData();
  const hookRaw = await readPart(form.get("hook"));
  if (!hookRaw) return json({ error: "missing_hook_payload" }, 400);

  let hook;
  try {
    hook = JSON.parse(hookRaw);
  } catch {
    return json({ error: "bad_hook_payload" }, 400);
  }

  const record = parseRecordBlock(hook.last_assistant_message || "");
  if (!record) {
    // 평가 턴이 아니면 조용히 무시한다 (클라이언트가 이미 걸러주지만 이중 방어).
    return json({ skipped: "no_record_block" });
  }

  // --- 인증: refresh token -> ID token ---
  const tokenRes = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.rt,
      }),
    }
  );
  if (!tokenRes.ok) {
    return json({ error: "auth_failed", detail: await tokenRes.text() }, 401);
  }
  const tokens = await tokenRes.json();
  const idToken = tokens.id_token;
  const uid = tokens.user_id;
  if (!uid || (creds.uid && creds.uid !== uid)) {
    return json({ error: "uid_mismatch" }, 401);
  }

  // --- 프로필 조회: 페어링 코드 무효화 여부 + 전사 저장 동의 ---
  const prof = await fetchProfile(cfg, idToken, uid);

  // 웹앱에서 "연결 코드 무효화"를 누르면 tokenVersion 이 올라가고, 예전 코드는 여기서 거부된다.
  if ((creds.tv || 1) < prof.tokenVersion) {
    return json({ error: "token_revoked" }, 401);
  }

  // 가입 승인제가 켜져 있으면 승인된 계정만 기록을 남길 수 있다.
  // firestore.rules 가 어차피 막지만, 여기서 걸러야 유저에게 이유를 알려줄 수 있다.
  if (uid !== cfg.ownerUid && prof.approved !== true) {
    if (await approvalRequired(cfg, idToken)) {
      return json({
        systemMessage:
          "⛔ CPX 기록판 관리자 승인 대기 중입니다 · 승인 후부터 기록이 자동 저장됩니다",
      });
    }
  }

  // 클라이언트가 이미 전사를 안 보냈더라도 서버에서 한 번 더 막는다.
  const consent = prof.consentTranscript;

  let transcript = "";
  let truncated = false;
  if (consent) {
    const rawTranscript = await readPart(form.get("transcript"));
    if (rawTranscript) {
      transcript = renderTranscript(rawTranscript);
      if (transcript.length > MAX_TRANSCRIPT_CHARS) {
        transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
        truncated = true;
      }
    }
  }

  const evaluation = clip(hook.last_assistant_message || "", 60000);
  const now = new Date().toISOString();

  // 두 문서가 같은 id 를 쓰도록 여기서 만든다. 웹앱이 기록 id 로 본문을 바로 찾는다.
  const docId = newDocId();
  const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
  const headers = {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
  };

  // 본문은 따로 둔다. 목록에는 날짜·주제·점수만 필요한데 본문까지 한 문서에 있으면
  // 기록을 열어보지도 않고 전사를 전부 내려받게 된다.
  // 긴 문자열은 색인 항목 크기 제한(7.5KiB)에 걸려 쓰기가 거부되므로 조각내어 배열로 넣는다.
  const bodyDoc = {
    fields: {
      uid: str(uid),
      evaluationChunks: chunks(evaluation),
      transcriptChunks: chunks(transcript),
      transcriptTruncated: { booleanValue: truncated },
      createdAt: { timestampValue: now },
    },
  };

  const doc = {
    fields: {
      uid: str(uid),
      source: str("plugin"),
      topic: str(record.topic || "무작위"),
      totalScore: int(record.total),
      historyScore: int(record.history),
      peScore: int(record.pe),
      ppiScore: int(record.ppi),
      grade: str(record.grade || ""),
      note: str(record.summary || ""),
      // 본문 자체가 아니라 "있다/없다" 만 남긴다. 웹앱이 보기 버튼을 낼지 이걸로 정한다.
      hasEvaluation: { booleanValue: Boolean(evaluation) },
      hasTranscript: { booleanValue: Boolean(transcript) },
      sessionId: str(hook.session_id || ""),
      createdAt: { timestampValue: now },
    },
  };
  // null 점수 필드는 제거 (Firestore 는 undefined 를 허용하지 않음)
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v === null) delete doc.fields[k];
  }

  // 본문을 먼저 쓴다. 순서가 반대면 "전사 있다고 표시된 기록인데 본문이 없는" 상태가 생긴다.
  const bodyRes = await fetch(`${base}/recordDetails?documentId=${docId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyDoc),
  });
  if (!bodyRes.ok) {
    return json({ error: "write_failed", detail: await bodyRes.text() }, 502);
  }

  const writeRes = await fetch(`${base}/records?documentId=${docId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(doc),
  });
  if (!writeRes.ok) {
    // 기록이 없으면 본문은 주인 없는 문서로 남는다. 지워두되, 실패해도 흐름은 막지 않는다.
    await fetch(`${base}/recordDetails/${docId}`, { method: "DELETE", headers }).catch(() => {});
    return json({ error: "write_failed", detail: await writeRes.text() }, 502);
  }

  // Stop 훅은 2xx 본문을 JSON output 형식으로 해석한다. systemMessage 는 사용자에게 표시된다.
  const label = record.total == null ? "" : ` (${record.total}점)`;
  return json({
    systemMessage: `✅ CPX 기록 저장됨${label}${consent ? "" : " · 전사 미저장"}`,
  });
}

// ---------------- helpers ----------------

// records 와 recordDetails 가 같은 id 를 쓰도록 여기서 만든다.
// Firestore 자동 id 와 같은 모양(영숫자 20자).
function newDocId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function decodePairingToken(token) {
  const norm = token.replace(/-/g, "+").replace(/_/g, "/");
  const parsed = JSON.parse(atob(norm));
  if (parsed.v !== 1 || !parsed.rt) throw new Error("unsupported token");
  return parsed;
}

async function readPart(part) {
  if (!part) return "";
  return typeof part === "string" ? part : await part.text();
}

/**
 * 평가 메시지 끝의 ```cpx-record { ... } ``` 블록을 뽑아낸다.
 * 이 블록은 skills/start/SKILL.md 가 반드시 출력하도록 지시한다.
 */
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

/**
 * Claude Code 의 .jsonl 전사를 "의사:/환자:" 형태의 평문으로 변환한다.
 *
 * 기록판의 "문진 전사" 탭은 실제로 오간 면담만 보여줘야 한다. 원본 .jsonl 에는
 * 면담이 아닌 줄이 훨씬 많으므로 아래를 전부 걷어낸다:
 *   - 슬래시 명령 줄(`<command-name>`)과 그때 주입되는 SKILL.md 본문(`isMeta`)
 *   - 도구 호출·도구 결과·thinking·첨부·요약 등 대화가 아닌 엔트리
 *   - `<system-reminder>` 같은 시스템 주입 블록
 *   - 서브에이전트(sidechain) 대화
 *   - 마지막 채점 메시지 — evaluationChunks 로 따로 저장돼 "채점 결과" 탭에 뜬다
 *   - 면담을 끝내려고 친 `평가` 신호 (면담 내용이 아니라 조작 명령이다)
 *   - 채점이 끝난 뒤 같은 채팅에서 이어간 대화 (아래 참조)
 *
 * 면담은 구간으로 끊어 읽는다. `/cpx:` 명령이 구간을 열고, `평가` 신호나 채점
 * 메시지가 그 구간을 닫는다. 닫힌 뒤부터 다음 `/cpx:` 명령까지의 줄은 면담이
 * 아니므로 아예 모으지 않는다 — 학생이 채점 결과를 두고 이어서 묻는 대화가
 * 그것이다. 업로드는 채점 턴에서만 일어나는데, 재채점이나 두 번째 케이스로
 * 같은 세션에서 업로드가 또 일어나면 그 뒤풀이 대화까지 통째로 전사에 실렸다.
 *
 * 결과로 남기는 것은 닫힌 구간 하나다. 아직 채점 전이면(=닫힌 구간이 없으면)
 * 모으는 중인 구간을 그대로 쓴다.
 *
 * 형식이 바뀌어도 죽지 않도록 모든 단계를 방어적으로 처리한다.
 */
function renderTranscript(jsonl) {
  let cur = [];       // 모으는 중인 면담
  let done = null;    // 채점으로 닫힌 면담
  let closed = false; // 채점 뒤 — 다음 `/cpx:` 명령까지는 아무것도 모으지 않는다
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 앞부분이 잘린 첫 줄 등
    }

    // 대화 턴이 아닌 엔트리(attachment·summary·title 등)
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    // isMeta = 슬래시 명령이 주입한 SKILL.md 본문, isSidechain = 서브에이전트 대화
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;
    // 도구 결과 턴
    if (entry.toolUseResult !== undefined) continue;

    const msg = entry.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (hasToolBlock(msg.content)) continue;

    const raw = extractText(msg.content);
    // 슬래시 명령 줄은 새 케이스의 시작점으로만 쓰고 본문에는 넣지 않는다.
    // 앞 케이스에서 닫아둔 구간도 여기서 버린다 — 이제 이번 케이스가 기록된다.
    if (/<command-name>\s*\/cpx:/.test(raw)) {
      cur = [];
      done = null;
      closed = false;
      continue;
    }

    const text = cleanText(raw);
    if (!text) continue;
    // 면담이 끝나는 두 지점. 채점 결과는 "채점 결과" 탭에 이미 통째로 있고,
    // `평가` 는 면담을 끊는 조작 신호라 둘 다 전사 본문에는 넣지 않는다.
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
    // 채점 뒤에 이어진 대화(오답 질문·잡담)는 면담이 아니다.
    if (closed) continue;

    cur.push(`${msg.role === "user" ? "의사" : "환자"}: ${text}`);
  }
  return (done || cur).join("\n\n");
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

// 대화 본문에 섞여 들어오는 시스템 주입 블록과 명령 태그.
const NOISE_TAGS =
  /<(system-reminder|command-message|command-name|command-args|command-contents|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
// 면담 종료 신호. `진찰` 은 신체진찰 단계의 시작점을 보여주므로 남긴다.
const END_SIGNAL = /^평가[\s.!]*$/;
// 사용자가 입력한 것이 아니라 클라이언트가 남기는 안내 줄.
const NOISE_LINES = /^\[(Request interrupted|No response requested)[^\]]*\]$/;

function cleanText(s) {
  const stripped = String(s ?? "")
    .replace(NOISE_TAGS, "")
    .replace(/<\/?(system-reminder|command-[a-z]+)>/g, "")
    .trim();
  return NOISE_LINES.test(stripped) ? "" : stripped;
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

async function fetchProfile(cfg, idToken, uid) {
  const fallback = { consentTranscript: false, tokenVersion: 1 };
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/users/${uid}`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  // 유저 문서가 없으면 동의하지 않은 것으로 보수적으로 처리한다.
  if (!res.ok) return fallback;
  const fields = (await res.json())?.fields || {};
  return {
    consentTranscript: fields.consentTranscript?.booleanValue === true,
    tokenVersion: parseInt(fields.tokenVersion?.integerValue ?? "1", 10) || 1,
    approved: fields.approved?.booleanValue === true,
  };
}

// config/app 의 승인제 스위치. 문서가 없거나 읽기 실패하면 꺼진 것으로 본다
// — 스위치를 못 읽었다고 멀젖한 유저의 기록을 버리지 않기 위해서다.
async function approvalRequired(cfg, idToken) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/config/app`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  if (!res.ok) return false;
  const fields = (await res.json())?.fields || {};
  return fields.requireApproval?.booleanValue === true;
}

function str(v) {
  return { stringValue: String(v ?? "") };
}

// 한글은 UTF-8 에서 글자당 3바이트라 1500자면 약 4.5KB — 색인 항목 상한 7.5KiB 아래다.
const CHUNK_CHARS = 1500;

function chunks(s) {
  const text = String(s ?? "");
  const values = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    values.push({ stringValue: text.slice(i, i + CHUNK_CHARS) });
  }
  return { arrayValue: { values } };
}

function int(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? { integerValue: String(n) } : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

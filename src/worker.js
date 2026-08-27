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
const WORKER_VERSION = "2026-08-27.1";

const MAX_TRANSCRIPT_CHARS = 700000; // Firestore 문서 상한 1MiB 대비 여유
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, version: WORKER_VERSION });
    if (url.pathname !== "/upload") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    try {
      return await handleUpload(request, env);
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
      // 긴 문자열은 색인 항목 크기 제한(7.5KiB)에 걸려 쓰기가 거부된다.
      // 조각내어 배열로 저장하면 조각마다 색인이 잡히므로 콘솔에서 색인 예외를
      // 만들지 않아도 된다. 웹앱이 다시 이어붙여 보여준다.
      evaluationChunks: chunks(clip(hook.last_assistant_message || "", 60000)),
      transcriptChunks: chunks(transcript),
      transcriptTruncated: { booleanValue: truncated },
      sessionId: str(hook.session_id || ""),
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };
  // null 점수 필드는 제거 (Firestore 는 undefined 를 허용하지 않음)
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v === null) delete doc.fields[k];
  }

  const writeRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/records`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(doc),
    }
  );
  if (!writeRes.ok) {
    return json({ error: "write_failed", detail: await writeRes.text() }, 502);
  }

  // Stop 훅은 2xx 본문을 JSON output 형식으로 해석한다. systemMessage 는 사용자에게 표시된다.
  const label = record.total == null ? "" : ` (${record.total}점)`;
  return json({
    systemMessage: `✅ CPX 기록 저장됨${label}${consent ? "" : " · 전사 미저장"}`,
  });
}

// ---------------- helpers ----------------

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
 *
 * `/cpx:` 명령을 만나면 그때까지 모은 줄을 버린다. 한 세션에서 여러 케이스를
 * 돌렸을 때 마지막 케이스의 면담만 남기기 위한 것이다.
 *
 * 형식이 바뀌어도 죽지 않도록 모든 단계를 방어적으로 처리한다.
 */
function renderTranscript(jsonl) {
  let out = [];
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
    if (/<command-name>\s*\/cpx:/.test(raw)) {
      out = [];
      continue;
    }

    const text = cleanText(raw);
    if (!text) continue;
    // 채점 결과는 "채점 결과" 탭에 이미 통째로 있으므로 전사에서는 뺀다.
    if (text.includes("```cpx-record")) continue;
    // 면담을 끝내는 조작 신호. 면담 내용이 아니므로 전사에 남기지 않는다.
    if (msg.role === "user" && END_SIGNAL.test(text)) continue;

    out.push(`${msg.role === "user" ? "의사" : "환자"}: ${text}`);
  }
  return out.join("\n\n");
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

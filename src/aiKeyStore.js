/**
 * 계정별 AI 키 보관 — 검증과 암호화. 런타임 의존(KV·fetch)이 없어서 test/aiKeyStore.test.mjs 가 그대로 import 한다.
 *
 * 면담 탭의 "내 계정에 키 저장"을 켠 사용자의 키를 KV(`aikeys:{uid}`)에 둔다. Firebase 규칙을 건드리지 않아도 되고,
 * 워커가 이미 하고 있는 Firebase 토큰 확인(aiRoutes.js authenticate)을 그대로 쓴다.
 *
 * 워커 비밀값 KEY_ENCRYPTION_SECRET 이 있으면 AES-GCM 으로 암호화해 저장한다(키는 비밀값+uid 로 계정마다 다르게 만든다).
 * 없으면 평문(p1:)으로 저장한다 — 비밀값을 나중에 추가해도 예전 데이터는 그대로 읽히고, 새로 저장하는 것부터 암호화된다.
 * 운영자는 비밀값을 가진 사람이라 기술적으로는 복호화할 수 있다 — 화면 안내문에도 그렇게 적혀 있다.
 */

// 웹 기록판의 docs/aikeys.js KEY_PROVIDERS 와 같아야 한다. "free"(키 없음)는 저장할 키가 없다.
export const KEY_PROVIDERS = ["gemini", "openai", "anthropic", "openrouter"];
export const MAX_VALUE_CHARS = 400; // API 키·모델 이름보다 훨씬 넉넉하다
export const MAX_BODY_CHARS = 4000; // 요청 전체 상한 — 이 엔드포인트를 임의 데이터 저장소로 쓰지 못하게

/** {제공자: 문자열} 에서 허용된 제공자와 알맞은 문자열만 남긴다. */
export function pickKnown(obj) {
  const out = {};
  for (const id of KEY_PROVIDERS) {
    const v = obj && typeof obj[id] === "string" ? obj[id].trim() : "";
    if (v && v.length <= MAX_VALUE_CHARS) out[id] = v;
  }
  return out;
}

/** put 요청 바디를 저장할 내용으로 정리한다. 올바른 모양이 아니면 null. */
export function normalizePut(body) {
  if (!body || typeof body !== "object") return null;
  if (JSON.stringify(body).length > MAX_BODY_CHARS) return null;
  const provider = body.aiProvider === "free" || KEY_PROVIDERS.includes(body.aiProvider) ? body.aiProvider : "free";
  return { aiKeys: pickKnown(body.aiKeys), aiModels: pickKnown(body.aiModels), aiProvider: provider };
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(secret, uid) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}|${uid}|aikeys-v1`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 저장할 문자열로 만든다. secret 이 있으면 암호화(e1:), 없으면 평문(p1:). */
export async function seal(obj, secret, uid) {
  const json = JSON.stringify(obj);
  if (!secret) return `p1:${json}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(secret, uid), new TextEncoder().encode(json));
  return `e1:${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

/** 저장된 문자열을 객체로 되돌린다. 없으면 null. 암호화돼 있는데 secret 이 없거나 다른 계정 것이면 예외. */
export async function open(stored, secret, uid) {
  if (!stored) return null;
  if (stored.startsWith("p1:")) return JSON.parse(stored.slice(3));
  if (stored.startsWith("e1:")) {
    if (!secret) throw new Error("secret_missing");
    const [iv, ct] = stored.slice(3).split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await deriveKey(secret, uid), unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  return null;
}

// 배포된 워커의 "키 없이 바로" 웹 면담(/interview/ai/*)을 터미널에서 한 턴씩 돌린다.
// 사이트 면담 화면과 같은 요청을 보내므로 실제 모델 응답을 그대로 볼 수 있다.
//
//   CPX_PAIR_TOKEN=<기록판 '연결 코드'> node scripts/live_interview.mjs status
//   ... start "가슴통증"           새 면담 (주호소는 index.json 표기·별칭. 비우면 무작위)
//   ... say "어떻게 오셨어요?"      학생 한 마디 → 환자 응답 출력
//   ... log                        지금까지 대화 전체 출력
//   ... usage                      오늘 면담별 사용량 (관리자 계정만)
//
// 대화 상태는 CPX_LIVE_STATE(기본 ./.live_interview.json)에 남는다. 연결 코드는 refresh token 을
// 담은 자격증명이라 환경변수로만 받고 파일에 쓰지 않는다. 하루 뉴런 한도·1인 면담 수 한도를
// 실제로 쓰므로 필요한 만큼만 돌릴 것.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENDPOINT = process.env.CPX_ENDPOINT || "https://cpx-upload.raphael40402652.workers.dev";
const API_KEY = "AIzaSyD1rN6_CvmmjvV40kRGD37f7TZ2ZwNZpqA"; // wrangler.toml 의 공개 식별자
const STATE = process.env.CPX_LIVE_STATE || ".live_interview.json";

async function idToken() {
  const raw = process.env.CPX_PAIR_TOKEN;
  if (!raw) throw new Error("CPX_PAIR_TOKEN 환경변수가 없습니다");
  const pair = JSON.parse(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: pair.rt }),
  });
  const data = await res.json();
  if (!res.ok || !data.id_token) throw new Error(`토큰 교환 실패: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.id_token;
}

async function call(path, body, auth = true) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await idToken()}`;
  const res = await fetch(ENDPOINT + path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");

if (cmd === "status") {
  console.log(JSON.stringify(await call("/interview/ai/status", {}, false), null, 2));
} else if (cmd === "start") {
  const data = await call("/interview/ai/start", arg ? { topic: arg } : {});
  save({ ...data, messages: [], neurons: 0 });
  console.log(JSON.stringify(data, null, 2));
} else if (cmd === "say") {
  const s = load();
  if (!s) throw new Error("먼저 start 하세요");
  const messages = [...s.messages, { role: "user", text: arg }];
  const data = await call("/interview/ai/chat", { sessionId: s.sessionId, messages });
  messages.push({ role: "assistant", text: data.reply });
  save({ ...s, messages, neurons: s.neurons + (data.neurons || 0) });
  console.log(data.reply);
  const u = data.usage || {};
  console.log(`\n[이번 턴 뉴런 ${data.neurons}${data.neurons === 0 ? " (모델 없이 답함)" : ""} · 이 면담 누적 ${u.neurons ?? "?"} · 모델 ${u.modelTurns ?? "?"}턴 / 서버 ${u.localTurns ?? "?"}턴]`);
} else if (cmd === "usage") {
  console.log(JSON.stringify(await call("/interview/ai/usage", {}), null, 2));
} else if (cmd === "log") {
  const s = load();
  for (const m of s?.messages || []) console.log(`${m.role === "user" ? "학생" : "환자"}: ${m.text}\n`);
} else {
  console.log("사용법: status | start [주호소] | say <말> | log | usage");
}

# CPX 업로드 워커

Claude Code의 Stop 훅이 보낸 평가 결과를 Firestore에 기록하는 중계 서버입니다.
Cloudflare Workers 무료 플랜(하루 10만 요청)에서 돕니다.

## 왜 서버가 필요한가

훅이 보내는 것과 Firestore가 받는 것 사이에 변환이 필요합니다.

1. 페어링 토큰 → Firebase ID token 교환 (`securetoken.googleapis.com`)
2. 평가 메시지에서 ` ```cpx-record ` 블록 파싱
3. 전사 `.jsonl` → 사람이 읽는 텍스트 (`/cpx:start` 부터 채점까지의 면담만 남기고 슬래시 명령·SKILL.md 주입·도구 호출·채점 메시지·채점 뒤 대화는 버림)
4. Firestore REST의 타입 지정 형식(`{"stringValue": ...}`)으로 조립

이걸 로컬 스크립트에서 하려면 Node나 jq가 필요한데, 유저 PC에 있으리라는 보장이 없습니다.
서버로 옮기면 유저 쪽은 `curl` 하나만 있으면 됩니다.

## 보안상 중요한 성질

**이 워커는 자격증명을 하나도 보관하지 않습니다.** 유저가 보낸 페어링 토큰 안의
refresh token으로 그 유저 본인의 ID token을 받아, **유저 자격으로** Firestore에 씁니다.
따라서 `firestore.rules` 의 `uid == request.auth.uid` 검사가 그대로 적용되고,
워커가 뚫려도 관리자 권한이 새지 않습니다.

`FIREBASE_API_KEY` 와 `FIREBASE_PROJECT_ID` 는 웹앱에도 노출되는 공개 식별자라
평문으로 두어도 됩니다.

---

## 배포 — `python scripts/deploy_multi.py` (권장)

저장소 최상단에서:

```bash
python scripts/deploy_multi.py
```

wrangler 없이 Cloudflare REST API 로 바로 올립니다. `wrangler.toml` 을 읽어
워커 이름·진입 파일·호환 날짜·`[vars]` 를 그대로 쓰므로 설정 출처는 한 곳뿐입니다.
지금 `worker.js` 는 `interviewRoutes.js`·`sampleCase.js`·`interviewPrompt.js`·케이스 JSON
58개를 import 하는 **다중 모듈** 구조라, `src/` 아래 모든 `.js`/`.json` 을 훑어 각 모듈을
이름별로 함께 업로드하는 이 스크립트가 필요합니다. Python 표준 라이브러리(`tomllib`)와
`requests` 패키지만 있으면 됩니다(`pip install requests`).

**토큰**은 `~/.cloudflare-token` 에 한 줄로 두거나 `CLOUDFLARE_API_TOKEN` 환경변수로 줍니다.
Cloudflare 대시보드 → **My Profile → API Tokens → Create Token** → `Edit Cloudflare Workers`
템플릿으로 만듭니다. **이 저장소는 공개이니 토큰을 안에 두지 마세요.**
토큰을 만들고 쓰는 것 자체는 무료입니다 — 과금은 Workers 사용량(무료 10만 요청/일)에만 걸립니다.

### `deploy.sh` 는 더 이상 쓰지 마세요

`deploy.sh` 는 `worker.js` 하나만 단일 파일로 업로드합니다. 웹 면담 기능이 들어오면서
`worker.js` 가 다른 파일을 import 하는 다중 모듈 구조로 바뀌었는데(`c2e9159`), `deploy.sh`
는 그 이전 구조를 전제로 만들어진 스크립트라 지금은 배포를 시도하면 Cloudflare 가 모듈
해석 실패로 거부합니다. 저장소에는 참고용으로 남아 있지만 **위 `deploy_multi.py` 를 쓰세요.**
(단일 파일 워커로 되돌리는 일이 있다면 그때는 다시 유효합니다.)

### 왜 wrangler 를 기본으로 안 쓰나

작업 PC 의 node 가 한컴 번들 32비트(`ia32`)뿐인데, wrangler 는 시작하자마자 `workerd` 를
`require` 하고 `workerd` 는 64비트 바이너리만 배포합니다. `--version` 조차 돌지 않습니다
(`Unsupported platform: win32 ia32 LE`). `curl`/`python` 은 64비트로 이미 있어 API 경로가
설치 없이 됩니다.

64비트 Node 를 깔면 `wrangler deploy` 로 갈아타도 됩니다 — `wrangler.toml` 을 그대로 씁니다.
GitHub Actions(`.github/workflows/deploy.yml`)의 자동 배포는 러너가 64비트라 이미 wrangler
로 정상 동작합니다 — `main` 에 푸시하면 이 문제와 무관하게 항상 다중 모듈이 올바르게 번들됩니다.

---

## 배포 A — 대시보드 (수동 대안, 현재 코드베이스에선 지원 안 됨)

> ⚠️ **다중 모듈 구조가 된 뒤로 이 방법은 쓸 수 없습니다.** 대시보드의 기본 코드 편집기는
> 파일 하나만 받습니다. `worker.js` 를 그대로 붙여넣으면 `import "./interviewRoutes.js"` 가
> 해석되지 않아 워커가 뜨지 않거나(웹 면담 라우트가 500 을 내거나) 배포 자체가 거부됩니다.
> 대시보드로 꼭 배포해야 한다면 편집기의 **다중 파일** 기능으로 `src/` 아래 모든 파일을
> 각각의 상대 경로 이름으로 올리세요. 아래 절차는 워커가 `worker.js` 하나뿐이던
> 시절의 기록이라 지금은 참고용입니다 — **위 `deploy_multi.py` 를 쓰세요.**

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Workers** →
   **Create Worker**. 이름을 `cpx-upload` 로 하면 주소가 `cpx-upload.<계정>.workers.dev` 가 됩니다.
2. 일단 **Deploy** 를 눌러 기본 워커를 만든 뒤 **Edit code** 로 들어갑니다.
3. 편집기 내용을 전부 지우고 [`src/worker.js`](src/worker.js) 를 통째로 붙여넣고 **Deploy**.
4. 워커 페이지 → **Settings → Variables and Secrets** → **Add** 로 두 개 등록:

   | 이름 | 값 |
   |---|---|
   | `FIREBASE_PROJECT_ID` | Firebase 프로젝트 ID |
   | `FIREBASE_API_KEY` | Firebase `apiKey` |

   Type은 둘 다 **Text** 로 두면 됩니다 (비밀값이 아님). 저장 후 재배포됩니다.

5. 동작 확인:

```bash
curl https://cpx-upload.<계정>.workers.dev/health
```

`{"ok":true,"version":"2026-08-27.1"}` 가 나오면 정상입니다.
`version` 은 `src/worker.js` 의 `WORKER_VERSION` 값입니다 — 붙여넣기가 제대로 됐는지를
이 값으로 판별합니다. 워커를 고칠 때 이 상수도 같이 올리세요.

> 이 방식은 코드를 대시보드에 붙여넣는 것이라, 워커를 고칠 때마다 다시 붙여넣어야 합니다.
> 원본은 이 저장소의 `src/worker.js` 를 정본으로 두고 관리하세요.

## 배포 B — Wrangler (64비트 Node 필요)

`wrangler.toml` 의 `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` 를 채운 뒤:

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

---

## 배포 후 할 일

나온 주소를 플러그인의 `hooks/upload.sh` 와 `hooks/upload.ps1` 의 `ENDPOINT` 에 넣으세요.

## 테스트

파싱 로직(기록 블록 추출, 전사 렌더링, 페어링 토큰) 테스트가 들어 있습니다.
**Node가 있어야 실행됩니다.**

```bash
node --test
```

Node 없이 검증하려면 실제 연습을 한 번 돌려보고 기록판에 행이 생기는지 확인하는 수밖에 없습니다.
그때 워커 로그는 대시보드의 워커 페이지 → **Logs → Begin log stream** 에서 실시간으로 볼 수 있습니다.

`worker.js` 를 고치면 `test/parse.test.mjs` 의 동일 구현도 함께 고쳐야 합니다. `main` 에
푸시하면 `.github/workflows/deploy.yml` 이 배포 전에 이 테스트를 먼저 돌립니다 — 로컬에
Node 가 없어도 테스트가 실패하는 채로 배포되는 일은 이제 없습니다.

## 레이트리밋 (선택)

`/interview/start` 는 로그인·페어링 토큰이 필요 없습니다 — 학생 브라우저가 세션을 시작하기
전부터 부르는 경로라서요. 그만큼 열려 있어서, 외부에서 스크립트로 반복 호출하면 Cloudflare
무료 한도(하루 10만 요청)를 실제 학생 몫까지 갉아먹을 수 있습니다.

`wrangler.toml` 의 `[[kv_namespaces]]` 블록 주석을 풀고 KV 네임스페이스를 만들어 `id` 를
채우면(`npx wrangler kv namespace create RATE_LIMIT_KV`), IP 당 10분에 20회로 제한됩니다.
**주석 처리된 채로 두면(기본값) 레이트리밋 없이 그냥 통과합니다** — 존재하지 않는 네임스페이스
id 로 배포를 깨뜨리지 않기 위한 안전한 기본값입니다. `deploy_multi.py`·`wrangler` 둘 다
이 섹션을 자동으로 바인딩에 반영하므로, `id` 를 채우고 주석만 풀면 됩니다.

## 엔드포인트

| 경로 | 설명 |
|---|---|
| `POST /upload` | `Authorization: Bearer <페어링토큰>` + multipart(`hook`, 선택 `transcript`) |
| `GET /health` | 헬스체크 |

`/upload` 는 실패해도 non-2xx를 돌려줄 뿐이며, Claude Code는 이를 non-blocking error로
처리하므로 유저의 세션이 끊기지 않습니다.

#!/usr/bin/env bash
# Cloudflare Workers 배포 — wrangler 없이 REST API 로 직접 올린다.
#
# 왜 wrangler 를 안 쓰나:
#   이 작업 PC 의 node 는 한컴 번들 32비트(ia32)뿐인데, wrangler 는 시작하자마자
#   workerd 를 require 하고 workerd 는 64비트 바이너리만 배포한다. --version 조차 안 돈다.
#   curl 은 64비트로 이미 깔려 있어 이 경로가 설치 없이 바로 된다.
#   64비트 node 를 깔면 `wrangler deploy` 로 갈아타도 된다 — wrangler.toml 은 그대로 쓸 수 있다.
#
# 토큰: ~/.cloudflare-token 파일 한 줄, 또는 CLOUDFLARE_API_TOKEN 환경변수.
#   Cloudflare 대시보드 > My Profile > API Tokens > "Edit Cloudflare Workers" 템플릿으로 만든다.
#   저장소 안에 두지 말 것 (이 저장소는 공개다).
set -euo pipefail

cd "$(dirname "$0")"

# ---------- 토큰 ----------
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TF="$HOME/.cloudflare-token"
  [ -f "$TF" ] || { echo "토큰이 없습니다: $TF (또는 CLOUDFLARE_API_TOKEN)" >&2; exit 1; }
  # BOM·CR·앞뒤 공백을 걷어낸다 (메모장으로 저장하면 섞이기 쉽다).
  TOKEN=$(sed -e '1s/^\xEF\xBB\xBF//' "$TF" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
fi
[ -n "$TOKEN" ] || { echo "토큰이 비어 있습니다" >&2; exit 1; }

# ---------- wrangler.toml 을 유일한 설정 출처로 읽는다 ----------
# 값이 여기와 스크립트 두 곳에 갈리면 조용히 어긋나므로 파일에서만 읽는다.
toml_str() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" wrangler.toml | head -1; }

NAME=$(toml_str name)
MAIN=$(toml_str main)
COMPAT=$(toml_str compatibility_date)
[ -n "$NAME" ] && [ -n "$MAIN" ] && [ -n "$COMPAT" ] || {
  echo "wrangler.toml 에서 name/main/compatibility_date 를 읽지 못했습니다" >&2; exit 1; }
[ -f "$MAIN" ] || { echo "진입 파일이 없습니다: $MAIN" >&2; exit 1; }

# [vars] 아래의 KEY = "값" 들을 bindings JSON 으로 옮긴다.
BINDINGS=$(awk '
  /^\[vars\]/        { inv = 1; next }
  /^\[/              { inv = 0 }
  inv && /=/ {
    key = $0; sub(/[[:space:]]*=.*/, "", key); gsub(/[[:space:]]/, "", key)
    val = $0; sub(/^[^=]*=[[:space:]]*"/, "", val); sub(/".*/, "", val)
    if (key != "" && key !~ /^#/)
      printf "%s{\"type\":\"plain_text\",\"name\":\"%s\",\"text\":\"%s\"}", (n++ ? "," : ""), key, val
  }
' wrangler.toml)

MODULE=$(basename "$MAIN")
METADATA="{\"main_module\":\"$MODULE\",\"compatibility_date\":\"$COMPAT\",\"bindings\":[$BINDINGS]}"

echo "워커      : $NAME"
echo "진입 파일 : $MAIN"
echo "호환 날짜 : $COMPAT"
echo "변수      : $(echo "$BINDINGS" | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' | tr '\n' ' ')"

# ---------- 계정 ----------
# 계정 id 를 저장소에 박지 않고 매번 조회한다.
API=https://api.cloudflare.com/client/v4
ACC=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API/accounts" \
      | python -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
[ -n "$ACC" ] || { echo "계정을 찾지 못했습니다 (토큰 권한 확인)" >&2; exit 1; }

# ---------- 배포 ----------
echo "올리는 중..."
RESP=$(curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=$METADATA;type=application/json" \
  -F "$MODULE=@$MAIN;type=application/javascript+module" \
  "$API/accounts/$ACC/workers/scripts/$NAME")

echo "$RESP" | python -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("success"):
    print("배포 실패:", d.get("errors")); sys.exit(1)
print("배포 완료:", (d.get("result") or {}).get("modified_on"))
'

# ---------- 확인 ----------
# WORKER_VERSION 을 안 올리면 배포가 됐는지 밖에서 판별할 수 없다.
SRC_VER=$(sed -n 's/.*WORKER_VERSION = "\([^"]*\)".*/\1/p' "$MAIN" | head -1)
LIVE=$(curl -fsS "https://$NAME.$(echo "${WORKERS_SUBDOMAIN:-raphael40402652}").workers.dev/health" || echo '{}')
LIVE_VER=$(echo "$LIVE" | python -c 'import sys,json; print((json.load(sys.stdin) or {}).get("version",""))' 2>/dev/null || echo "")
echo "소스 버전 : $SRC_VER"
echo "배포 버전 : ${LIVE_VER:-(확인 실패)}"
[ "$SRC_VER" = "$LIVE_VER" ] && echo "일치" || echo "불일치 — WORKER_VERSION 을 올렸는지, 전파를 기다렸는지 확인하세요"

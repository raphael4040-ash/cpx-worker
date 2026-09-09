#!/usr/bin/env python3
"""Cloudflare Workers 배포 — wrangler 없이 REST API 로 직접 올린다 (다중 모듈판).

deploy.sh 와 같은 이유(이 작업 PC 의 node 는 wrangler 를 못 돌리는 32비트)로 존재하지만,
지금 워커는 worker.js 하나가 아니라 여러 파일(+ 케이스 JSON 58개)을 import 하는
다중 모듈 구조라 deploy.sh 의 단일 파일 업로드로는 안 된다. 이 스크립트는 wrangler.toml
을 그대로 읽어 각 모듈을 이름별로 올리고, [vars] 와 [[kv_namespaces]] 를 bindings 로 옮긴다.

토큰: ~/.cloudflare-token 파일 한 줄, 또는 CLOUDFLARE_API_TOKEN 환경변수.
"""
import json
import os
import sys
import tomllib
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
API = "https://api.cloudflare.com/client/v4"

CONTENT_TYPE = {".js": "application/javascript+module", ".json": "application/json"}


def get_token():
    tok = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if tok:
        return tok
    tf = Path.home() / ".cloudflare-token"
    if not tf.exists():
        sys.exit(f"토큰이 없습니다: {tf} (또는 CLOUDFLARE_API_TOKEN)")
    return tf.read_text(encoding="utf-8-sig").strip()


def load_config():
    with open(ROOT / "wrangler.toml", "rb") as f:
        return tomllib.load(f)


def collect_modules():
    """src/ 아래 모든 .js .json 을 훑어서, main.js 기준 상대경로를 이름으로 쓴다.
    (personas.json/index.json/case 파일들이 늘어나도 자동으로 다 잡힌다.)"""
    src = ROOT / "src"
    modules = {}
    for p in src.rglob("*"):
        if p.is_file() and p.suffix in (".js", ".json"):
            name = str(p.relative_to(src)).replace("\\", "/")
            modules[name] = p
    return modules


def main():
    token = get_token()
    cfg = load_config()

    name = cfg["name"]
    main_path = cfg["main"]  # 예: "src/worker.js"
    main_name = main_path.split("/", 1)[1] if main_path.startswith("src/") else main_path
    compat = cfg["compatibility_date"]

    bindings = []
    for k, v in cfg.get("vars", {}).items():
        bindings.append({"type": "plain_text", "name": k, "text": str(v)})
    for kv in cfg.get("kv_namespaces", []):
        bindings.append({"type": "kv_namespace", "name": kv["binding"], "namespace_id": kv["id"]})

    modules = collect_modules()
    if main_name not in modules:
        sys.exit(f"진입 모듈을 못 찾았습니다: {main_name} (src/ 아래에 있어야 함)")

    print(f"워커      : {name}")
    print(f"진입 모듈 : {main_name}")
    print(f"호환 날짜 : {compat}")
    print(f"바인딩    : {[b['name'] for b in bindings]}")
    print(f"모듈 개수 : {len(modules)}")

    metadata = {
        "main_module": main_name,
        "compatibility_date": compat,
        "bindings": bindings,
    }

    headers = {"Authorization": f"Bearer {token}"}

    acc_resp = requests.get(f"{API}/accounts", headers=headers, timeout=30)
    acc_resp.raise_for_status()
    accounts = acc_resp.json().get("result") or []
    if not accounts:
        sys.exit("계정을 찾지 못했습니다 (토큰 권한 확인)")
    account_id = accounts[0]["id"]

    files = [("metadata", (None, json.dumps(metadata), "application/json"))]
    for mod_name, path in modules.items():
        if path.suffix == ".json":
            # Cloudflare 의 원시 업로드 API는 application/json 모듈을 안 받는다
            # (wrangler 는 이걸 내부적으로 JS로 바꿔서 올린다). 이름은 .json 그대로 두되
            # 내용을 export default 로 감싸고 javascript+module 로 올린다 — import 하는
            # 쪽(예: "./cases/personas.json")은 이름으로만 찾으므로 그대로 연결된다.
            body = b"export default " + path.read_bytes() + b";"
            files.append((mod_name, (mod_name, body, "application/javascript+module")))
        else:
            files.append((mod_name, (mod_name, path.read_bytes(), CONTENT_TYPE[path.suffix])))

    print("올리는 중...")
    resp = requests.put(
        f"{API}/accounts/{account_id}/workers/scripts/{name}",
        headers=headers,
        files=files,
        timeout=120,
    )
    data = resp.json()
    if not data.get("success"):
        print("배포 실패:", json.dumps(data.get("errors"), ensure_ascii=False, indent=2))
        sys.exit(1)
    print("배포 완료:", (data.get("result") or {}).get("modified_on"))


if __name__ == "__main__":
    main()

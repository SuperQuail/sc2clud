#!/usr/bin/env bash
# ============================================================
# SC2clud 端到端冒烟测试（Linux / CI 版，与 scripts/smoke.ps1 等价）
#
# 自包含：自己拉起服务、跑完检查、自己收尾。
# 只依赖 curl / openssl / 基本 coreutils，不依赖 jq。
# ============================================================
set -uo pipefail

PORT="${SC2CLUD_SMOKE_PORT:-18081}"
SECRET="smoke-secret"
BASE="http://127.0.0.1:$PORT"
FAILURES=0

ok() { printf '  ok  %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
check() { if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }

# 定位二进制：Linux 无后缀，Windows（msys）带 .exe
EXE="${SC2CLUD_BIN:-}"
if [ -z "$EXE" ]; then
  for cand in target/debug/sc2clud target/debug/sc2clud.exe; do
    if [ -x "$cand" ]; then EXE="$cand"; break; fi
  done
fi
if [ -z "$EXE" ] || [ ! -x "$EXE" ]; then
  echo "找不到可执行文件，请先 cargo build -p sc2clud-app" >&2
  exit 2
fi

WORK="$(mktemp -d)"
# msys/cygwin 下给原生 exe 传 POSIX 路径会解析错误，转换一次；Linux 上没有 cygpath，保持原样。
if command -v cygpath >/dev/null 2>&1; then
  export SC2CLUD_DATA_DIR="$(cygpath -w "$WORK")"
else
  export SC2CLUD_DATA_DIR="$WORK"
fi
export SC2CLUD_DOWNLOAD_SECRET="$SECRET"
export SC2CLUD_BIND="127.0.0.1:$PORT"
export SC2CLUD_BASE_URL="$BASE"
export SC2CLUD_LOG=warn
export SC2CLUD_MAX_UPLOAD_BYTES=65536

SERVER_LOG="$WORK/server.log"
"$EXE" serve >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  sleep 0.3
  if [ "$FAILURES" -eq 0 ]; then rm -rf "$WORK"; else echo "工作目录保留在：$WORK"; fi
}
trap cleanup EXIT

READY=0
for _ in $(seq 1 60); do
  sleep 0.2
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/readyz")
  if [ "$code" = "200" ]; then READY=1; break; fi
done
if [ "$READY" != "1" ]; then
  tail -n 30 "$SERVER_LOG" >&2
  echo '服务未能在 12 秒内就绪' >&2
  exit 2
fi
ok 'readyz 返回 200'

# JSON 字段提取：被测接口的响应是我们自己生成的扁平 JSON，字段顺序稳定。
field() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
number() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }

health=$(curl -s "$BASE/healthz")
check "$(printf '%s' "$health" | grep -c '\"ok\"')" 'healthz 返回 status=ok'

# ---------- 上传 ----------
SRC="$WORK/payload.bin"
head -c 8192 /dev/urandom > "$SRC"
if command -v md5sum >/dev/null 2>&1; then SRC_MD5=$(md5sum "$SRC" | cut -d' ' -f1); else SRC_MD5=$(openssl dgst -md5 "$SRC" | awk '{print $NF}'); fi

NAME=$(printf '%s' '地图 包.bin' | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g')
code=$(curl -s -o "$WORK/upload.json" -w '%{http_code}' -X PUT --data-binary "@$SRC" \
  "$BASE/api/v1/files?name=$NAME&mime=application%2Foctet-stream")
body=$(cat "$WORK/upload.json")
check "$( [ "$code" = '200' ] && echo 1 || echo 0 )" "上传返回 200（实际 $code）"
check "$( [ "$(number "$body" size)" = '8192' ] && echo 1 || echo 0 )" '返回 size = 8192'
check "$(printf '%s' "$body" | grep -c '\"deduplicated\":false')" '首次上传 deduplicated=false'
HASH=$(field "$body" hash)
ID=$(number "$body" id)
check "$( [ "${#HASH}" = '64' ] && echo 1 || echo 0 )" '返回 64 位 blake3 摘要'

# ---------- 盘上内容寻址与字节一致 ----------
BLOB="$WORK/blobs/${HASH:0:2}/${HASH:2:2}/$HASH"
check "$( [ -f "$BLOB" ] && echo 1 || echo 0 )" '内容落在 blobs/<ab>/<cd>/<hash>'
if [ -f "$BLOB" ]; then
  if command -v md5sum >/dev/null 2>&1; then BLOB_MD5=$(md5sum "$BLOB" | cut -d' ' -f1); else BLOB_MD5=$(openssl dgst -md5 "$BLOB" | awk '{print $NF}'); fi
  check "$( [ "$BLOB_MD5" = "$SRC_MD5" ] && echo 1 || echo 0 )" '盘上字节与源文件逐字节一致'
fi
check "$( [ -z "$(ls -A "$WORK/blobs/tmp" 2>/dev/null)" ] && echo 1 || echo 0 )" '中转目录已清空（无 .part 残留）'

# ---------- 秒传 ----------
CLAIM=$(curl -s -X POST -H 'content-type: application/json' \
  --data-binary "{\"name\":\"copy.bin\",\"hash\":\"$HASH\",\"size\":8192}" \
  "$BASE/api/v1/files/claim")
check "$(printf '%s' "$CLAIM" | grep -c '\"deduplicated\":true')" '秒传命中并返回 deduplicated=true'
CLAIM_ID=$(number "$CLAIM" id)

WRONG_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data-binary "{\"name\":\"x.bin\",\"hash\":\"$HASH\",\"size\":999}" \
  "$BASE/api/v1/files/claim")
check "$( [ "$WRONG_CODE" = '409' ] && echo 1 || echo 0 )" "声明体积不符被拒绝（409，实际 $WRONG_CODE）"

  # ---------- 下载跳转与签名 ----------
  DL=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' "$BASE/api/v1/files/$ID/download")
  DL_CODE="${DL%%|*}"
  LOCATION="${DL#*|}"
  check "$( [ "$DL_CODE" = '302' ] && echo 1 || echo 0 )" "下载返回 302（实际 $DL_CODE）"
  check "$(printf '%s' "$LOCATION" | grep -c '/dl/')" '跳转目标是 /dl/ 下的受保护路径'

  DL_PATH=$(printf '%s' "${LOCATION%%\?*}" | sed 's|^[a-zA-Z]*://[^/]*||')
  QUERY="${LOCATION#*\?}"
  EXPIRES=$(printf '%s' "$QUERY" | tr '&' '\n' | grep '^e=' | cut -d= -f2)
  SIG=$(printf '%s' "$QUERY" | tr '&' '\n' | grep '^s=' | cut -d= -f2)
  NOW=$(date +%s)
  check "$( [ "$EXPIRES" -gt "$NOW" ] && echo 1 || echo 0 )" '签名带未来过期时间'
  check "$( [ "$EXPIRES" -le $((NOW + 400)) ] && echo 1 || echo 0 )" 'TTL 是短时（≤ 400 秒）'
  check "$(printf '%s' "$DL_PATH" | grep -c "$HASH")" '受保护路径包含内容摘要'

  # 用 openssl 独立复算 nginx secure_link_md5 的表达式
  EXPECTED=$(printf '%s' "$EXPIRES$DL_PATH"127.0.0.1" $SECRET" \
    | openssl dgst -md5 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  check "$( [ "$SIG" = "$EXPECTED" ] && echo 1 || echo 0 )" '签名与 nginx secure_link_md5 表达式逐字节一致'

  # ---------- 超限拒绝：不得留下截断内容 ----------
  head -c 131072 /dev/urandom > "$WORK/big.bin"
  BIG_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary "@$WORK/big.bin" "$BASE/api/v1/files?name=big.bin")
  check "$( [ "$BIG_CODE" = '413' ] && echo 1 || echo 0 )" "超出单文件上限被拒（413，实际 $BIG_CODE）"
  check "$( [ -z "$(ls -A "$WORK/blobs/tmp" 2>/dev/null)" ] && echo 1 || echo 0 )" '超限请求清理了中转文件'
  COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
  check "$( [ "$COUNT" = '1' ] && echo 1 || echo 0 )" "盘上仍只有 1 份内容（实际 $COUNT）"

  # ---------- 引用计数：删一个引用不动内容，全删才回收 ----------
  DEL1=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v1/files/$ID")
  check "$( [ "$DEL1" = '204' ] && echo 1 || echo 0 )" "删除第一个引用返回 204（实际 $DEL1）"
  COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
  check "$( [ "$COUNT" = '1' ] && echo 1 || echo 0 )" '仍有其他引用时，物理内容保留'

  DEL2=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v1/files/$CLAIM_ID")
  check "$( [ "$DEL2" = '204' ] && echo 1 || echo 0 )" "删除第二个引用返回 204（实际 $DEL2）"
  COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
  check "$( [ "$COUNT" = '0' ] && echo 1 || echo 0 )" '引用归零后物理内容被回收'

  PAGE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$BASE/f/$ID")
  check "$( [ "$PAGE_CODE" = '404' ] && echo 1 || echo 0 )" "删除后详情页 404（实际 $PAGE_CODE）"
  HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$BASE/")
  check "$( [ "$HOME_CODE" = '200' ] && echo 1 || echo 0 )" "首页服务端渲染 200（实际 $HOME_CODE）"

  # ---------- 写回缓冲：下载计数最终落库 ----------
  if command -v sqlite3 >/dev/null 2>&1; then
    sleep 12   # 刷盘间隔 10 秒
    VALUE=$(sqlite3 "$WORK/sc2clud.sqlite3" "SELECT value FROM counters WHERE key='file:$ID:downloads';")
    check "$( [ "$VALUE" = '1' ] && echo 1 || echo 0 )" "下载计数已批量落库（实际 $VALUE）"
  else
    echo '  --  跳过计数落库检查（未找到 sqlite3）'
  fi

  if [ "$FAILURES" -gt 0 ]; then
    echo "冒烟测试失败：$FAILURES 项" >&2
    exit 1
  fi
  echo '冒烟测试全部通过'

#!/usr/bin/env bash
# ============================================================
# SC2clud 端到端冒烟测试（Linux / CI 版，与 scripts/smoke.ps1 等价）
#
# 覆盖：探针 → 未登录不得访问 → 口令重置 → 登录 → 上传 → 盘上一致性 → 秒传 →
#       签名（用 openssl 独立复算 nginx 表达式）→ 超限 → 引用计数回收 → 游客首页不泄露
#
# 依赖：curl、openssl、coreutils。不需要 jq。
# ============================================================
set -uo pipefail

PORT="${SC2CLUD_SMOKE_PORT:-18081}"
BASE="http://127.0.0.1:$PORT"
PASSWORD='smoke-pass'
FAILURES=0

ok() { printf '  ok  %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
check() { if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
field() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
number() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }

# 二进制：debug 优先，其次 release（CI 里先跑 release 构建）
EXE="${SC2CLUD_BIN:-}"
if [ -z "$EXE" ]; then
  for cand in target/debug/sc2clud target/debug/sc2clud.exe target/release/sc2clud target/release/sc2clud.exe; do
    if [ -x "$cand" ]; then EXE="$cand"; break; fi
  done
fi
if [ -z "$EXE" ] || [ ! -x "$EXE" ]; then
  echo '找不到可执行文件：请先 cargo build -p sc2clud-app' >&2
  exit 2
fi

WORK="$(mktemp -d)"
# msys/cygwin 下要给原生 exe 传 Windows 路径；Linux 上没有 cygpath，保持原样。
if command -v cygpath >/dev/null 2>&1; then
  export SC2CLUD_DATA_DIR="$(cygpath -w "$WORK")"
else
  export SC2CLUD_DATA_DIR="$WORK"
fi
export SC2CLUD_DOWNLOAD_SECRET='smoke-secret'
export SC2CLUD_BIND="127.0.0.1:$PORT"
export SC2CLUD_BASE_URL="$BASE"
export SC2CLUD_LOG=warn
export SC2CLUD_MAX_UPLOAD_BYTES=65536
# 冒烟实例在本地跑，没有 nginx：让应用自己回图片字节（生产由 nginx 直出）。
export SC2CLUD_SERVE_BLOBS_LOCALLY=1
# 显式设定阈值，避免继承外部会话里的残值
export SC2CLUD_MIN_FREE_BYTES=5242880000
JAR="$WORK/cookies.txt"
SERVER_LOG="$WORK/server.log"

"$EXE" serve >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  sleep 0.3
  if [ "$FAILURES" -eq 0 ]; then rm -rf "$WORK"; else echo "工作目录保留：$WORK"; fi
}
trap cleanup EXIT

READY=0
for _ in $(seq 1 60); do
  sleep 0.2
  if [ "$(code "$BASE/readyz")" = '200' ]; then READY=1; break; fi
done
if [ "$READY" != '1' ]; then tail -n 30 "$SERVER_LOG" >&2; echo '服务未能在 12 秒内就绪' >&2; exit 2; fi
ok 'readyz 返回 200'

# ---------- 未登录：什么都拿不到 ----------
check "$( [ "$(code "$BASE/api/v1/files")" = '401' ] && echo 1 || echo 0 )" '未登录访问文件列表 → 401'
PAGE="$(curl -s "$BASE/")"
printf '%s' "$PAGE" | grep -q '登录' && check 1 '游客首页给出登录入口' || check 0 '游客首页给出登录入口'
printf '%s' "$PAGE" | grep -q '我的文件' && check 0 '游客首页不显示任何人的网盘内容' || check 1 '游客首页不显示任何人的网盘内容'

# ---------- 登录 ----------
"$EXE" set-password demo "$PASSWORD" >/dev/null 2>&1
LOGIN="$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -X POST -d 'account=demo' -d "password=$PASSWORD" "$BASE/login")"
check "$( [ "$LOGIN" = '303' ] || [ "$LOGIN" = '302' ] && echo 1 || echo 0 )" "登录成功并下发会话（实际 $LOGIN）"
grep -q 'sc2clud_session' "$JAR" && check 1 '会话 Cookie 已保存' || check 0 '会话 Cookie 已保存'
check "$( [ "$(code -b "$JAR" "$BASE/api/v1/files")" = '200' ] && echo 1 || echo 0 )" '登录后文件列表 200'

# ---------- 上传与盘上一致性 ----------
SRC="$WORK/payload.bin"
head -c 8192 /dev/urandom > "$SRC"
SRC_MD5=$(openssl dgst -md5 "$SRC" | awk '{print $NF}')
NAME=$(printf '%s' '地图 包.bin' | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g')
UP_CODE=$(curl -s -b "$JAR" -o "$WORK/upload.json" -w '%{http_code}' -X PUT --data-binary "@$SRC" "$BASE/api/v1/files?name=$NAME")
BODY="$(cat "$WORK/upload.json")"
check "$( [ "$UP_CODE" = '200' ] && echo 1 || echo 0 )" "上传返回 200（实际 $UP_CODE）"
check "$( [ "$(number "$BODY" size)" = '8192' ] && echo 1 || echo 0 )" '返回 size = 8192'
printf '%s' "$BODY" | grep -q '地图 包.bin' && check 1 '中文文件名原样保留' || check 0 '中文文件名原样保留'
HASH=$(field "$BODY" hash)
ID=$(number "$BODY" id)
check "$( [ "${#HASH}" = '64' ] && echo 1 || echo 0 )" '返回 64 位 blake3 摘要'
BLOB="$WORK/blobs/${HASH:0:2}/${HASH:2:2}/$HASH"
check "$( [ -f "$BLOB" ] && echo 1 || echo 0 )" '内容落在 blobs/<ab>/<cd>/<hash>'
if [ -f "$BLOB" ]; then
  check "$( [ "$(openssl dgst -md5 "$BLOB" | awk '{print $NF}')" = "$SRC_MD5" ] && echo 1 || echo 0 )" '盘上字节与源文件逐字节一致'
fi
check "$( [ -z "$(ls -A "$WORK/blobs/tmp" 2>/dev/null)" ] && echo 1 || echo 0 )" '中转目录已清空'

# ---------- 秒传 ----------
CLAIM_BODY="{\"name\":\"copy.bin\",\"hash\":\"$HASH\",\"size\":8192}"
printf '%s' "$CLAIM_BODY" > "$WORK/claim.json"
CLAIM=$(curl -s -b "$JAR" -H 'content-type: application/json' --data-binary "@$WORK/claim.json" "$BASE/api/v1/files/claim")
printf '%s' "$CLAIM" | grep -q '"deduplicated":true' && check 1 '秒传命中并返回 deduplicated=true' || check 0 '秒传命中并返回 deduplicated=true'
CLAIM_ID=$(number "$CLAIM" id)

# ---------- 下载与签名 ----------
DL=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}|%{redirect_url}' "$BASE/api/v1/files/$ID/download")
DL_CODE="${DL%%|*}"
LOCATION="${DL#*|}"
check "$( [ "$DL_CODE" = '302' ] && echo 1 || echo 0 )" "下载返回 302（实际 $DL_CODE）"
DL_PATH=$(printf '%s' "${LOCATION%%\?*}" | sed 's|^[a-zA-Z]*://[^/]*||')
QUERY="${LOCATION#*\?}"
EXPIRES=$(printf '%s' "$QUERY" | tr '&' '\n' | grep '^e=' | cut -d= -f2)
SIG=$(printf '%s' "$QUERY" | tr '&' '\n' | grep '^s=' | cut -d= -f2)
EXPECTED=$(printf '%s' "$EXPIRES$DL_PATH"127.0.0.1" smoke-secret" | openssl dgst -md5 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
check "$( [ "$SIG" = "$EXPECTED" ] && echo 1 || echo 0 )" '签名与 nginx secure_link_md5 表达式逐字节一致'

# ---------- 超限与回收 ----------
head -c 131072 /dev/urandom > "$WORK/big.bin"
BIG=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary "@$WORK/big.bin" "$BASE/api/v1/files?name=big.bin")
check "$( [ "$BIG" = '413' ] && echo 1 || echo 0 )" "超限被拒（413，实际 $BIG）"
COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
check "$( [ "$COUNT" = '1' ] && echo 1 || echo 0 )" "盘上仍只有 1 份内容（实际 $COUNT）"
check "$( [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/files/$ID")" = '204' ] && echo 1 || echo 0 )" '删除第一个引用 204'
COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
check "$( [ "$COUNT" = '1' ] && echo 1 || echo 0 )" '仍有引用时内容保留'
check "$( [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/files/$CLAIM_ID")" = '204' ] && echo 1 || echo 0 )" '删除第二个引用 204'
COUNT=$(find "$WORK/blobs" -type f | wc -l | tr -d ' ')
check "$( [ "$COUNT" = '0' ] && echo 1 || echo 0 )" '引用归零后回收物理内容'

# ---------- 帖子图片 ----------
printf '%s' '{"title":"带图帖","body":"配图与封面测试","kind":"discussion"}' > "$WORK/post.json"
POST_BODY=$(curl -s -b "$JAR" -H 'content-type: application/json' --data-binary "@$WORK/post.json" "$BASE/api/v1/posts")
POST_ID=$(number "$POST_BODY" id)
IMG_SRC='crates/sc2clud-web/static/art/miyin-chibi-160.webp'
IMG_UP=$(curl -s -b "$JAR" -X POST --data-binary "@$IMG_SRC" "$BASE/api/v1/posts/$POST_ID/images")
IMG_HASH=$(field "$IMG_UP" hash)
check "$( [ -n "$IMG_HASH" ] && echo 1 || echo 0 )" '帖子配图上传成功'
IMG_CODE=$(curl -s -o "$WORK/back.webp" -w '%{http_code}' "$BASE/img/$IMG_HASH")
check "$( [ "$IMG_CODE" = '200' ] && echo 1 || echo 0 )" "图片可按内容摘要读取（$IMG_CODE）"
printf 'plain text' > "$WORK/not-image.txt"
BAD_IMG=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST --data-binary "@$WORK/not-image.txt" "$BASE/api/v1/posts/$POST_ID/images")
check "$( [ "$BAD_IMG" = '400' ] && echo 1 || echo 0 )" "非图片按魔数被拒（$BAD_IMG）"
curl -s "$BASE/" | grep -q 'post-cover' && check 1 '首页卡片渲染了封面' || check 0 '首页卡片渲染了封面'

# ---------- 磁盘闸门：可用空间低于阈值时拒绝写入 ----------
GUARD_PORT=$((PORT + 1))
GUARD_DIR="$WORK/guard"
mkdir -p "$GUARD_DIR"
SC2CLUD_DATA_DIR="$GUARD_DIR" SC2CLUD_BIND="127.0.0.1:$GUARD_PORT" \
  SC2CLUD_BASE_URL="http://127.0.0.1:$GUARD_PORT" SC2CLUD_MIN_FREE_BYTES=1099511627776 \
  "$EXE" serve >"$GUARD_DIR/server.log" 2>&1 &
GUARD_PID=$!
for _ in $(seq 1 60); do sleep 0.2; if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GUARD_PORT/readyz")" = '200' ]; then break; fi; done
SC2CLUD_DATA_DIR="$GUARD_DIR" "$EXE" set-password demo "$PASSWORD" >/dev/null 2>&1
curl -s -c "$GUARD_DIR/c.txt" -o /dev/null -H "Origin: http://127.0.0.1:$GUARD_PORT" -X POST -d 'account=demo' -d "password=$PASSWORD" "http://127.0.0.1:$GUARD_PORT/login"
LOW_CODE=$(curl -s -o "$GUARD_DIR/low.json" -w '%{http_code}' -b "$GUARD_DIR/c.txt" -X PUT --data-binary '' "http://127.0.0.1:$GUARD_PORT/api/v1/files?name=x.txt")
check "$( [ "$LOW_CODE" = '507' ] && echo 1 || echo 0 )" "可用空间不足时上传被拒（507，实际 $LOW_CODE）"
grep -q '可用空间不足' "$GUARD_DIR/low.json" && check 1 '错误信息说明了原因' || check 0 '错误信息说明了原因'
kill "$GUARD_PID" 2>/dev/null || true

if [ "$FAILURES" -gt 0 ]; then echo "冒烟测试失败：$FAILURES 项" >&2; exit 1; fi
echo '冒烟测试全部通过'

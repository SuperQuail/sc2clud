set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
RP=$(grep -E '^FORUM_KV__PASSWORD=' /etc/sc2clud/dev.env | cut -d= -f2-)
B='http://127.0.0.1/dev'; H='Host: 191.40.41.97'; X='X-Forwarded-For: 198.18.241.241'
J=/tmp/btc2.jar; rm -f $J
CID=$(curl -s -H "$H" -H "$X" $B/api/v1/captcha | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
ANS=$(redis-cli -a "$RP" --no-auth-warning get "captcha:$CID")
curl -s -c $J -H "$H" -H "$X" -H 'Content-Type: application/json' -d "{\"login\":\"probe-admin\",\"password\":\"Probe-Dev-2026!\",\"captcha_id\":\"$CID\",\"captcha_answer\":\"$ANS\"}" $B/api/v1/auth/login >/dev/null
echo "=== A) 前端实际发的字段名（board_id，值是 slug）"
curl -s -o /tmp/a.json -w 'HTTP %{http_code}\n' -b $J -H "$H" -H "$X" -H 'Content-Type: application/json' \
  -d '{"board_id":"custom-campaign","kind":"discussion","title":"[盲测]UI 字段名探测 A","content_md":"probe"}' $B/api/v1/topics
head -c 300 /tmp/a.json; echo
echo "=== B) 后端契约要求的字段名（board=slug）"
curl -s -o /tmp/b.json -w 'HTTP %{http_code}\n' -b $J -H "$H" -H "$X" -H 'Content-Type: application/json' \
  -d '{"board":"custom-campaign","kind":"discussion","title":"[盲测]UI 字段名探测 B","content_md":"probe"}' $B/api/v1/topics
head -c 200 /tmp/b.json; echo
TIDB=$(python3 -c 'import json;print(json.load(open("/tmp/b.json"))["data"]["id"])' 2>/dev/null || true)
echo "=== 清理 B 造的行 TIDB=$TIDB"
if [ -n "$TIDB" ]; then
  psql "$DSN" -Atc "delete from posts where topic_id=(select id from topics where public_id='$TIDB'); delete from topics where public_id='$TIDB';"
  psql "$DSN" -Atc "select count(*) from topics where public_id='$TIDB'"
fi
echo "=== 残留 [盲测] 主题数"
psql "$DSN" -Atc "select count(*) from topics where title like '[盲测]%'"

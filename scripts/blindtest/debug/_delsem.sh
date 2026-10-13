set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
RP=$(grep -E '^FORUM_KV__PASSWORD=' /etc/sc2clud/dev.env | cut -d= -f2-)
B='http://127.0.0.1/dev'; H='Host: 191.40.41.97'; X='X-Forwarded-For: 198.18.240.240'
J=/tmp/btc.jar; rm -f $J
CID=$(curl -s -H "$H" -H "$X" $B/api/v1/captcha | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
ANS=$(redis-cli -a "$RP" --no-auth-warning get "captcha:$CID")
curl -s -c $J -H "$H" -H "$X" -H 'Content-Type: application/json' -d "{\"login\":\"probe-admin\",\"password\":\"Probe-Dev-2026!\",\"captcha_id\":\"$CID\",\"captcha_answer\":\"$ANS\"}" $B/api/v1/auth/login >/dev/null
echo "login ok"
TID=$(curl -s -b $J -H "$H" -H "$X" -H 'Content-Type: application/json' -d '{"board":"custom-campaign","kind":"discussion","title":"[盲测]删除语义探测","content_md":"probe"}' $B/api/v1/topics | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
echo "TID=$TID"
echo "--- 删除前 详情"
curl -s -o /dev/null -w 'status=%{http_code}\n' -b $J -H "$H" -H "$X" $B/api/v1/topics/$TID
echo "--- DELETE"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X DELETE -b $J -H "$H" -H "$X" $B/api/v1/topics/$TID
echo "--- 删除后 详情(作者)"
curl -s -w '\nstatus=%{http_code}\n' -b $J -H "$H" -H "$X" $B/api/v1/topics/$TID | head -c 400
echo "--- DB"
psql "$DSN" -Atc "select visibility from topics where public_id='$TID'"
echo "--- 清理这行"
psql "$DSN" -Atc "delete from posts where topic_id=(select id from topics where public_id='$TID'); delete from topics where public_id='$TID';"
echo "--- 确认没了"
psql "$DSN" -Atc "select count(*) from topics where public_id='$TID'"

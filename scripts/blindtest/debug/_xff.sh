set -u
B='http://127.0.0.1/dev'; H='Host: 191.40.41.97'
X='X-Forwarded-For: 198.51.100.77'
echo '=== captcha with spoofed XFF'
curl -s -o /tmp/x.json -w 'status=%{http_code}\n' -H "$H" -H "$X" $B/api/v1/captcha
head -c 200 /tmp/x.json; echo
echo '=== 5s later: what IP does the app log?'
sleep 1
journalctl -u sc2clud@dev -n 5 --no-pager | grep -o '"path":"[^"]*","status":[0-9]*,"ip":"[^"]*"' | tail -3
echo '=== redis keys matching limiter'
PASS=$(grep -iE '^FORUM_KV__PASSWORD=' /etc/sc2clud/dev.env | cut -d= -f2-)
redis-cli -a "$PASS" --no-auth-warning --scan --pattern 'auth:captcha:ip:*' | head -20

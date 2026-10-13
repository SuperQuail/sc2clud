set -u
B='http://127.0.0.1/dev'; H='Host: 191.40.41.97'
echo "=== raw captcha response"
curl -s -i -H "$H" $B/api/v1/captcha | head -c 1200
echo
echo "=== again"
curl -s -H "$H" $B/api/v1/captcha | head -c 400
echo
echo "=== healthz"
curl -s -H "$H" $B/healthz; echo
echo "=== app log tail"
journalctl -u sc2clud@dev -n 40 --no-pager 2>/dev/null | tail -40

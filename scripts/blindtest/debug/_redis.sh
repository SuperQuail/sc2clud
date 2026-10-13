set -u
echo "=== env file keys (values masked)"
sudo -n cat /etc/sc2clud/dev.env 2>/dev/null | sed -E 's/(=.*)/=<masked>/' || cat /etc/sc2clud/dev.env | sed -E 's/(=.*)/=<masked>/'
echo
echo "=== redis-cli -a test"
PASS=$(grep -iE '^FORUM_KV__PASSWORD=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "passlen=${#PASS}"
redis-cli -a "$PASS" --no-auth-warning ping
echo "=== sampled captcha key"
CID=$(curl -s -H 'Host: 191.40.41.97' http://127.0.0.1/dev/api/v1/captcha | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
echo "cid=$CID"
redis-cli -a "$PASS" --no-auth-warning get "captcha:$CID"

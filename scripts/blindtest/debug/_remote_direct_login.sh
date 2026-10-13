#!/usr/bin/env bash
# 在 dev 主机上执行：经 nginx upsteam 本机端口 8082 直接打 dev 实例，避免依赖公网。
set -u
B=http://127.0.0.1:8082
J=/tmp/bt-cookie.jar
rm -f $J
H=(-H 'Host: 191.40.41.97')

CID=$(curl -s "${H[@]}" "$B/api/v1/captcha" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
ANS=$(redis-cli --raw get "captcha:$CID")
echo "captcha_id=$CID answer=$ANS"
curl -s -i "${H[@]}" -c $J -H 'Content-Type: application/json' \
  -d "{\"login\":\"probe-admin\",\"password\":\"Probe-Dev-2026!\",\"captcha_id\":\"$CID\",\"captcha_answer\":\"$ANS\"}" \
  "$B/api/v1/auth/login" | tail -20
echo '--- jar ---'
cat $J
echo '--- me ---'
curl -s "${H[@]}" -b $J "$B/api/v1/me"
echo

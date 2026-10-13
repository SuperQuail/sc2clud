set -u
H='Host: 191.40.41.97'
B='http://127.0.0.1/dev'
echo '=== captcha'
curl -s -H "$H" $B/api/v1/captcha | head -c 600; echo
echo
echo '=== boards'
curl -s -H "$H" $B/api/v1/boards | head -c 3000; echo
echo
echo '=== topics?limit=2'
curl -s -H "$H" "$B/api/v1/topics?limit=2" | head -c 2500; echo
echo
echo '=== me(no cookie)'
curl -s -w '\nstatus=%{http_code}\n' -H "$H" $B/api/v1/me
echo
echo '=== users/probe-admin'
curl -s -w '\nstatus=%{http_code}\n' -H "$H" $B/api/v1/users/probe-admin | head -c 1200

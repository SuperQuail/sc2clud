set -u
CONF=/www/server/panel/vhost/nginx/sc2clud.conf
echo "=== grep limit_ in sc2clud.conf"
grep -n 'limit_req\|limit_conn\|limit_zone\|limit_rate' "$CONF" || echo '(none)'
echo
echo "=== grep limit_ in nginx.conf"
grep -n 'limit_req\|limit_conn\|limit_zone' /www/server/nginx/conf/nginx.conf || echo '(none)'
echo
echo "=== full sc2clud.conf"
cat -n "$CONF"

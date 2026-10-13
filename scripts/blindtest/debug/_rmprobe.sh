set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== 残留的探针用户"
psql "$DSN" -Atc "select id,username,created_at from users where username like 'bt-probe-%'"
echo "=== 删掉（这批用户名只可能由盲测脚本创建）"
psql "$DSN" -Atc "delete from users where username like 'bt-probe-%';"
echo "=== 复查"
psql "$DSN" -Atc "select count(*) from users where username like 'bt-probe-%'"
psql "$DSN" -Atc "select count(*) from users"

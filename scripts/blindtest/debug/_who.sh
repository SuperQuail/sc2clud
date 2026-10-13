set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== 最新的用户（看是不是我的痕迹）"
psql "$DSN" -Atc "select username,created_at from users order by id desc limit 5"
echo "=== 最新的主题"
psql "$DSN" -Atc "select public_id,title,visibility,created_at from topics order by id desc limit 5"
echo "=== 最新被删的 posts"
psql "$DSN" -Atc "select public_id,floor,visibility,updated_at,left(content_md,30) from posts where visibility='deleted' order by updated_at desc limit 5"
echo "=== 我自己的 [盲测] 与 bt-probe 痕迹（应为 0）"
psql "$DSN" -Atc "select count(*) from topics where title like '%盲测%'"
psql "$DSN" -Atc "select count(*) from users where username like 'bt-probe-%'"
psql "$DSN" -Atc "select count(*) from posts where content_md like '%bt-%盲测%' or content_md like '%盲测%'"

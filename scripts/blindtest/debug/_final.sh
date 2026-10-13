set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== 最终状态"
psql "$DSN" -Atc "select 'topics', count(*) from topics union all select 'posts', count(*) from posts union all select 'users', count(*) from users union all select 'likes', count(*) from likes union all select 'bookmarks', count(*) from bookmarks union all select 'reports', count(*) from reports"
echo "--- 软删行"
psql "$DSN" -Atc "select 'topics_deleted', count(*) from topics where visibility='deleted' union all select 'posts_deleted', count(*) from posts where visibility='deleted'"
echo "--- 我的痕迹"
psql "$DSN" -Atc "select count(*) from topics where title like '[盲测]%' or title like '%盲测%'"
psql "$DSN" -Atc "select count(*) from users where username like 'bt-probe-%' or username like 'probe-%' and username<>'probe-admin'"
psql "$DSN" -Atc "select count(*) from posts where content_md like '%盲测%'"
psql "$DSN" -Atc "select count(*) from posts where content_md like '%bt-%'"
echo "--- 靶子主题完好性"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d'"
psql "$DSN" -Atc "select p.public_id,p.floor,p.visibility,u.username,left(p.content_md,20) from posts p join users u on u.id=p.author_id where p.topic_id=(select id from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d') order by p.floor"

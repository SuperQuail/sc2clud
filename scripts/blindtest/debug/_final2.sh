set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== FINAL"
psql "$DSN" -Atc "select 'bt_topics',count(*) from topics where title like '%盲测%' union all select 'bt_users',count(*) from users where username like 'bt-probe-%' union all select 'bookmarks_mine',count(*) from bookmarks union all select 'reports_open',count(*) from reports where state='open'"
echo "--- probe-admin 的开放举报（应为 0）"
psql "$DSN" -Atc "select count(*) from reports where reporter_id=(select id from users where username='probe-admin')"
echo "--- 靶子主题 & 它的楼层"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d'"
psql "$DSN" -Atc "select p.floor,p.visibility,u.username,left(p.content_md,24) from posts p join users u on u.id=p.author_id where p.topic_id=(select id from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d') order by p.floor"
echo "--- 接口复核"
curl -s -H 'Host: 191.40.41.97' "http://127.0.0.1/dev/api/v1/topics/3db0425a-1053-5011-8484-a58e828fdd4d" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('title=%s | content_deleted=%s | content_md=%r | reply_count=%d | like_count=%d' % (d['title'],d['content_deleted'],d['content_md'],d['reply_count'],d['like_count']))
"
echo "--- 版本"
curl -s -H 'Host: 191.40.41.97' http://127.0.0.1/dev/healthz

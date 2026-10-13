set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
T=3db0425a-1053-5011-8484-a58e828fdd4d
echo "=== 现状"
psql "$DSN" -Atc "select p.public_id,p.floor,p.visibility,u.username,p.updated_at from posts p join users u on u.id=p.author_id where p.topic_id=(select id from topics where public_id='$T') order by p.floor"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count from topics where public_id='$T'"
echo "=== 还原：1 楼（作者 Alenger，不是我）改回 normal"
psql "$DSN" -Atc "update posts p set visibility='normal', updated_at=now()
  where p.topic_id=(select id from topics where public_id='$T')
    and p.visibility='deleted'
    and p.author_id <> (select id from users where username='probe-admin');"
echo "=== 主题行也确保 normal"
psql "$DSN" -Atc "update topics set visibility='normal' where public_id='$T' and visibility='deleted';"
echo "=== 还原后"
psql "$DSN" -Atc "select p.public_id,p.floor,p.visibility,u.username from posts p join users u on u.id=p.author_id where p.topic_id=(select id from topics where public_id='$T') order by p.floor"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='$T'"
echo "=== 页面实测"
curl -s -H 'Host: 191.40.41.97' "http://127.0.0.1/dev/api/v1/topics/$T" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('title=',d['title'],'| content_deleted=',d['content_deleted'],'| content_md=',repr(d['content_md']),'| reply_count=',d['reply_count'])
"

set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
T=3db0425a-1053-5011-8484-a58e828fdd4d
echo "=== 当前 topics 行"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='$T'"
echo "=== 该主题下的 posts（含被级联软删的）"
psql "$DSN" -Atc "select public_id,floor,visibility,author_id,(select username from users u where u.id=p.author_id),updated_at from posts p where topic_id=(select id from topics where public_id='$T') order by floor"
echo
echo "=== 归属判断：这些 posts 的作者是不是 Alenger（不是我 probe-admin）"
psql "$DSN" -Atc "select count(*) from posts p where p.topic_id=(select id from topics where public_id='$T') and p.author_id=(select id from users where username='probe-admin')"
echo "=== 恢复：把该主题下 **非 probe-admin 写的**、当前是 deleted 的楼层改回 normal，并把 1 楼的正文还原"
psql "$DSN" -Atc "update posts p set visibility='normal', updated_at=now()
  where p.topic_id=(select id from topics where public_id='$T')
    and p.visibility='deleted'
    and p.author_id <> (select id from users where username='probe-admin')
    and p.updated_at > now() - interval '30 minutes';"
echo "rc=$?"
echo "=== 恢复后"
psql "$DSN" -Atc "select public_id,floor,visibility,(select username from users u where u.id=p.author_id) from posts p where topic_id=(select id from topics where public_id='$T') order by floor"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count from topics where public_id='$T'"
echo
echo "=== 用页面实测：1 楼正文是否回来了"
curl -s -H 'Host: 191.40.41.97' "http://127.0.0.1/dev/api/v1/topics/$T" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('content_deleted =',d['content_deleted'])
print('content_md      =',repr(d['content_md'])[:200])
print('reply_count     =',d['reply_count'])
"
echo
echo "=== 全库还有多少软删的 posts（正常历史遗留）"
psql "$DSN" -Atc "select count(*) from posts where visibility='deleted'"
echo "=== 全库软删的 topics"
psql "$DSN" -Atc "select public_id,title from topics where visibility='deleted'"

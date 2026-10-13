set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
T=3db0425a-1053-5011-8484-a58e828fdd4d
echo "=== 删掉我自己(probe-admin)在那个主题下遗留的测试回复行（作者 != Alenger，且是 deleted）"
psql "$DSN" -Atc "delete from posts p where p.topic_id=(select id from topics where public_id='$T')
  and p.author_id=(select id from users where username='probe-admin') and p.visibility='deleted';"
echo "=== 删除它的点赞/举报残留（若有）"
psql "$DSN" -Atc "delete from likes where user_id=(select id from users where username='probe-admin') and target_type='post' and target_id not in (select id from posts);"
echo "=== 最终状态"
psql "$DSN" -Atc "select public_id,floor,visibility,(select username from users u where u.id=p.author_id) from posts p where topic_id=(select id from topics where public_id='$T') order by floor"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='$T'"
echo "=== 页面实测"
curl -s -H 'Host: 191.40.41.97' "http://127.0.0.1/dev/api/v1/topics/$T" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('title=',d['title'],'| content_deleted=',d['content_deleted'],'| content_md=',repr(d['content_md']),'| reply_count=',d['reply_count'],'| like_count=',d['like_count'])
"
echo "=== 全库软删统计"
psql "$DSN" -Atc "select 'topics' t, count(*) from topics where visibility='deleted' union all select 'posts', count(*) from posts where visibility='deleted' union all select 'users_total', count(*) from users"
echo "=== 我的 [盲测] 残留"
psql "$DSN" -Atc "select count(*) from topics where title like '[盲测]%'"
psql "$DSN" -Atc "select count(*) from users where username like 'bt-probe-%'"

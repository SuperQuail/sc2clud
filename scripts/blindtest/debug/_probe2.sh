set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
TID=$(psql "$DSN" -Atc "select public_id from topics where title like '[盲测]自动化主链路%' and visibility='deleted' order by id desc limit 1")
echo "TID=$TID"
echo "--- topics row"
psql "$DSN" -Atc "select public_id,visibility from topics where public_id='$TID'"
echo "--- posts rows for it"
psql "$DSN" -Atc "select public_id,floor,visibility,parent_id is null as top from posts where topic_id=(select id from topics where public_id='$TID') order by floor"
echo "--- API /posts (匿名)"
curl -s -H 'Host: 191.40.41.97' "http://127.0.0.1/dev/api/v1/topics/$TID/posts?limit=50" | python3 -c "
import sys,json
j=json.load(sys.stdin)
items=j.get('data') or []
print('count',len(items))
for p in items: print('  floor',p.get('floor'),'id',p.get('id'),'parent',p.get('parent_id'))
"
echo "--- 再找一个活主题里别人写的回复（用于 403 测试）"
psql "$DSN" -Atc "select p.public_id, p.floor, u.username, t.public_id as topic, t.visibility
 from posts p join topics t on t.id=p.topic_id join users u on u.id=p.author_id
 where t.visibility='normal' and u.username not in ('probe-admin') and p.visibility='normal'
 order by p.id desc limit 8"

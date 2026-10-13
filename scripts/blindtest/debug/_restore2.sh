set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
psql "$DSN" -Atc "update topics set visibility='normal', updated_at=now() where public_id='3db0425a-1053-5011-8484-a58e828fdd4d' and visibility='deleted' and title='火力全开系列战役Mod';"
echo "restore-visibility rc=$?"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count,like_count from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d'" 2>&1
echo "--- 该主题在列表里应该回来了"
curl -s -H 'Host: 191.40.41.97' 'http://127.0.0.1/dev/api/v1/topics?limit=50' | python3 -c "
import sys,json
j=json.load(sys.stdin)
hit=[t for t in j['data'] if t['id']=='3db0425a-1053-5011-8484-a58e828fdd4d']
print('visible in list:', bool(hit), hit[0]['title'] if hit else '')
print('total listed:', len(j['data']))
"
echo "--- 主题总数"
psql "$DSN" -Atc "select count(*) from topics" 2>&1
echo "--- 帖子总数"
psql "$DSN" -Atc "select count(*) from posts" 2>&1

set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== is the Alenger topic still there?"
psql "$DSN" -Atc "select public_id,title,visibility from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d'" 2>&1
echo "=== how many topics total / how many visible"
psql "$DSN" -Atc "select count(*) from topics" 2>&1
psql "$DSN" -Atc "select count(*) from topics where visibility='normal'" 2>&1
echo "=== recent soft-deleted topics"
psql "$DSN" -Atc "select public_id,title,visibility,updated_at from topics where visibility='deleted' order by updated_at desc limit 10" 2>&1
echo "=== backups available"
ls -lt /srv/sc2clud-dev/backups/ 2>&1 | head -10
echo "=== leftover blindtest topics"
psql "$DSN" -Atc "select public_id,title,visibility from topics where title like '[盲测]%'" 2>&1
echo "=== leftover blindtest posts"
psql "$DSN" -Atc "select public_id,floor,visibility,left(content_md,40) from posts where content_md like '%bt-45abfc%'" 2>&1

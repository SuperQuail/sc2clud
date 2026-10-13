set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
psql "$DSN" -Atc "select 'topics',count(*) from topics union all select 'posts',count(*) from posts union all select 'users',count(*) from users union all select 'likes',count(*) from likes union all select 'bookmarks',count(*) from bookmarks union all select 'reports',count(*) from reports union all select 'deleted_topics',count(*) from topics where visibility='deleted' union all select 'deleted_posts',count(*) from posts where visibility='deleted' union all select 'bt_topics',count(*) from topics where title like '%盲测%' union all select 'bt_users',count(*) from users where username like 'bt-probe-%'"
echo "--- target topic"
psql "$DSN" -Atc "select public_id,title,visibility,reply_count from topics where public_id='3db0425a-1053-5011-8484-a58e828fdd4d'"

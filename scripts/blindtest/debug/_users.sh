set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
psql "$DSN" -Atc "select column_name||' '||data_type||' '||coalesce(column_default,'')||' null='||is_nullable from information_schema.columns where table_name='users' order by ordinal_position" 2>&1
echo "--- probe-admin's role"
psql "$DSN" -Atc "select u.username, r.key, u.status, u.email_verified_at is not null, u.activated_at is not null from users u left join roles r on r.id=u.role_id where u.username='probe-admin'" 2>&1
echo "--- roles"
psql "$DSN" -Atc "select id,key,name from roles order by id" 2>&1

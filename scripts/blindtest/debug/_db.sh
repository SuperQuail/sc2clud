set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "=== psql present? "; command -v psql || echo '(no psql)'
echo "=== try psql"
psql "$DSN" -Atc "select current_database(), (select count(*) from topics) as topics, (select count(*) from users) as users" 2>&1 | head -5
echo
echo "=== mail accounts?"
psql "$DSN" -Atc "select count(*) from mail_accounts" 2>&1 | head -3
echo "=== probe-admin flags"
psql "$DSN" -Atc "select username,status,email_verified_at is not null as ev,activated_at is not null as act from users where username like 'probe%'" 2>&1 | head -5

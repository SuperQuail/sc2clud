set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
U="bt-probe-$(date +%s)"
echo "USERNAME=$U"
psql "$DSN" -Atc "insert into users (public_id,username,email,password_hash,nickname,status,email_verified_at,activated_at,role_id)
  select gen_random_uuid(),'$U','$U@example.invalid',password_hash,'$U','active',now(),now(),(select id from roles where key='user')
  from users where username='probe-admin' returning username,role_id;" 2>&1
echo "--- created:"
psql "$DSN" -Atc "select u.username, r.key from users u join roles r on r.id=u.role_id where u.username='$U'" 2>&1
echo "--- replies anomaly: 用 probe-admin 的旧主题(已删)不行，造一个临时主题看 /posts/{id}/replies"
echo "--- listReplies 实现：先看默认 limit"
grep -n 'func (s \*Service) ListReplies' -A 30 /srv/sc2clud-dev/current/../../sc2clud-dev/current 2>/dev/null | head -5 || true

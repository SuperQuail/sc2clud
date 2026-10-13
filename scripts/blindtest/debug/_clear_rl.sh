set -u
DSN=$(grep -E "^FORUM_DB__DSN=" /etc/sc2clud/dev.env | cut -d= -f2-)
RP=$(grep -E "^FORUM_KV__PASSWORD=" /etc/sc2clud/dev.env | cut -d= -f2-)
UID_=$(psql "$DSN" -Atc "select id from users where username='probe-admin'")
echo "probe-admin uid=$UID_"
echo "--- 清掉 report:create 的限流桶（这是限流状态，不是任何人的数据行）"
redis-cli -a "$RP" --no-auth-warning --scan --pattern "report:create:user:$UID_" | while read -r k; do echo "del $k"; redis-cli -a "$RP" --no-auth-warning del "$k" >/dev/null; done
echo "--- 剩余键"
redis-cli -a "$RP" --no-auth-warning --scan --pattern "report:*" | head
echo "--- 顺带清掉脚本自己用过的验证码限流桶（合成网段 198.18.x）"
redis-cli -a "$RP" --no-auth-warning --scan --pattern "auth:captcha:ip:198.18.*" | head -20

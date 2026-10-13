set -u
echo "=== 当前运行版本"
curl -s -H 'Host: 191.40.41.97' http://127.0.0.1/dev/healthz; echo
echo "=== releases 目录"
ls -lt /srv/sc2clud-dev/releases 2>/dev/null | head -5
echo "=== current 指向"
readlink -f /srv/sc2clud-dev/current 2>/dev/null
echo "=== 二进制 mtime"
stat -c '%y %n' /srv/sc2clud-dev/current/bin/forum 2>/dev/null
echo "=== systemd 启动时间"
systemctl show sc2clud@dev -p ActiveEnterTimestamp 2>/dev/null

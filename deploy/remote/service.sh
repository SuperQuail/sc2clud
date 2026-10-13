#!/usr/bin/env bash
# systemctl wrapper. Keeps 'start', 'stop' and 'restart' from becoming three
# remote scripts that drift apart.
. /tmp/sc2clud-lib.sh
action="${SC2CLUD_ACTION:?SC2CLUD_ACTION is required}"
case "$action" in
  start|stop|restart) ;;
  *) echo "unsupported action: $action" >&2; exit 1 ;;
esac
unit=$(unit_name)
systemctl "$action" "$unit"
sleep 1
printf '%s: %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || echo inactive)"

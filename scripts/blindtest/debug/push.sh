# 把 scripts/blindtest 下的一个 py 送到 dev 并执行（可重复运行）。
# 用法: bash scripts/blindtest/push.sh blindtest_write.py --json
set -e
PY="${1:-blindtest_write.py}"
shift || true
ARGS="${*:---json}"
REMOTE_DIR=/tmp/blindtest
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$HERE/.stage.sh"

python3 - "$HERE/$PY" "$REMOTE_DIR/$PY" "$ARGS" > "$STAGE" <<'PYEOF'
import base64, sys
src, dst, args = sys.argv[1], sys.argv[2], sys.argv[3]
b64 = base64.b64encode(open(src, 'rb').read()).decode('ascii')
print('set -e')
print("mkdir -p '%s'" % dst.rsplit('/', 1)[0])
print("printf '%%s' '%s' | base64 -d > '%s'" % (b64, dst))
print('python3 -c "import py_compile; py_compile.compile(\'%s\', doraise=True); print(\'COMPILE OK\')"' % dst)
print("md5sum '%s'" % dst)
print('set +e')
print("cd '%s'" % dst.rsplit('/', 1)[0])
print("python3 '%s' %s 2>&1" % (dst.rsplit('/', 1)[1], args))
print('echo "EXIT_CODE=$?"')
print('exit 0')
PYEOF

powershell -NoProfile -ExecutionPolicy Bypass -File "$HERE/remote.ps1" -Body "$STAGE"
rm -f "$STAGE"

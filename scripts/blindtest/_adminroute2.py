import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok,_ = bt_http.login()
cookie = [c for c in bt_http._jar if c.name=="forum_dev_session"][0].value
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\_adminroute2.mjs", cookie], capture_output=True, cwd=r"D:\Code\Rust\SC2clud", timeout=300)
print("rc", r.returncode, r.stderr.decode("utf-8","replace")[:400])

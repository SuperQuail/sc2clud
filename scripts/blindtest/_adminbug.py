import sys, json, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
bt_http.login()
cookie = [c for c in bt_http._jar if c.name=="forum_dev_session"][0].value
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\_adminbug.mjs", cookie], capture_output=True, cwd=r"D:\Code\Rust\SC2clud", timeout=300)
print("rc", r.returncode, r.stderr.decode("utf-8","replace")[:300])
print(open(r"D:\Code\Rust\SC2clud\shots\blindtest\_adminbug.json",encoding="utf-8").read())

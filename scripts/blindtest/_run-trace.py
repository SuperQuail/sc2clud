import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
cookie = [c for c in bt_http._jar if c.name == "forum_dev_session"][0].value
outdir = r"D:\Code\Rust\SC2clud\shots\blindtest\trace"
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\page-driver.mjs", cookie, outdir,
                    r"D:\Code\Rust\SC2clud\scripts\blindtest\plan-trace.json"],
                   capture_output=True, cwd=r"D:\Code\Rust\SC2clud", env=dict(os.environ, BT_CDP_PORT="9228"), timeout=300)
open(r"D:\Code\Rust\SC2clud\shots\blindtest\trace\_stdout.txt","w",encoding="utf-8").write((r.stdout or b"").decode("utf-8","replace"))
print("exit", r.returncode)

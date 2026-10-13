import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http

ok, info = bt_http.login()
assert ok, info
cookie = [c for c in bt_http._jar if c.name == "forum_dev_session"][0].value
outdir = r"D:\Code\Rust\SC2clud\shots\blindtest\guest"
env = dict(os.environ, BT_CDP_PORT="9223")
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\page-driver.mjs", cookie,
                    outdir, r"D:\Code\Rust\SC2clud\scripts\blindtest\plan-pages.json"],
                   capture_output=True, text=True, cwd=r"D:\Code\Rust\SC2clud", env=env, timeout=900)
open(r"D:\Code\Rust\SC2clud\shots\blindtest\_driver-stdout.txt", "w", encoding="utf-8").write((r.stdout or "") + "\n--- STDERR ---\n" + (r.stderr or ""))
print("driver exit:", r.returncode)
print("pages:", len(json.load(open(os.path.join(outdir, "pages.json"), encoding="utf-8"))))

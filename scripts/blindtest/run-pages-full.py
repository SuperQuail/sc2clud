import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
assert ok, info
cookie = [c for c in bt_http._jar if c.name == "forum_dev_session"][0].value
outdir = r"D:\Code\Rust\SC2clud\shots\blindtest\full"
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\page-driver.mjs", cookie, outdir,
                    r"D:\Code\Rust\SC2clud\scripts\blindtest\plan-full.json"],
                   capture_output=True, cwd=r"D:\Code\Rust\SC2clud", env=dict(os.environ, BT_CDP_PORT="9230"), timeout=1800)
res = json.load(open(os.path.join(outdir, "pages.json"), encoding="utf-8"))
print("pages:", len(res))
for p in res:
    print("%-22s len=%-5d err=%-5s pe=%d 4xx=%d shot=%d" % (p["name"], p["bodyLen"], p["hasErrorBoundary"], len(p["pageErrors"]), len(p["http"]), p["shotBytes"]))

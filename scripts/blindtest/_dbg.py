import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
cookie = [c for c in bt_http._jar if c.name == "forum_dev_session"][0].value
outdir = r"D:\Code\Rust\SC2clud\shots\blindtest\dbg"
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\page-driver.mjs", cookie, outdir,
                    r"D:\Code\Rust\SC2clud\scripts\blindtest\plan-dbg.json"],
                   capture_output=True, cwd=r"D:\Code\Rust\SC2clud", env=dict(os.environ, BT_CDP_PORT="9231"), timeout=300)
res = json.load(open(os.path.join(outdir,"pages.json"), encoding="utf-8"))
for p in res:
    print(p["name"], "len", p["bodyLen"], "navErr", p["navErr"], "text:", p["text"][:120].replace("\n"," "))

import json, io, sys
res = json.load(open(r"D:\Code\Rust\SC2clud\shots\blindtest\_result.json", encoding="utf-8"))
out = []
out.append("ran_at=%s pages=%d api=%d" % (res.get("ran_at"), len(res["pages"]), len(res["api"])))
for v in res["verdicts"]:
    out.append("%-5s | %-24s | %s" % (v["verdict"], v["name"], v["why"][:200]))
out.append("")
out.append("=== API ===")
for a in res["api"]:
    out.append("%-5s | %-42s | %s | %s" % ("PASS" if a["ok"] else "FAIL", a["name"], a["status"], str(a["detail"])[:160]))
open(r"D:\Code\Rust\SC2clud\shots\blindtest\_summary.txt","w",encoding="utf-8").write("\n".join(out))
print("lines", len(out))

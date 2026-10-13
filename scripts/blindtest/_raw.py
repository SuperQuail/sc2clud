import sys, json, urllib.request
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
st, hd, raw = bt_http.call("GET", "/api/v1/topics?limit=2")
b = raw.encode("utf-8", "surrogatepass") if isinstance(raw, str) else raw
open(r"D:\Code\Rust\SC2clud\shots\blindtest\_topics_raw.json", "wb").write(b)
print("status", st, "content-type", hd.get("Content-Type"))
print("bytes", len(b), "bom", b[:3])
print("has U+FFFD:", b.count(b"\xef\xbf\xbd".decode('utf-8').encode('utf-8')))
print("raw head:", b[:200])

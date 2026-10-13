import sys, json
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
print("login:", ok)
for c in bt_http._jar:
    print("cookie:", c.name, "domain=", c.domain, "path=", c.path, "secure=", c.secure, "expires=", c.expires)
print("value head:", [ (c.name, c.value[:20]) for c in bt_http._jar ])

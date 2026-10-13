import sys, json, os
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
out = {}
# 1) /healthz 正确路径
st, hd, tx = bt_http.call("GET", "/healthz")
out["healthz"] = {"status": st, "body": tx[:200]}
st, hd, tx = bt_http.call("GET", "/api/v1/healthz")
out["api_healthz"] = {"status": st, "body": tx[:160]}
# 2) 不存在接口必须 404 JSON
for p in ["/api/v1/definitely-not-a-route", "/assets/nope.js", "/api/v1/topics/bad-id-format", "/api/v1/users/a/b/c"]:
    st, hd, tx = bt_http.call("GET", p)
    out["neg " + p] = {"status": st, "ct": hd.get("Content-Type",""), "body": tx[:150]}
# 3) q= 过滤到底有没有用
st, a = bt_http.jcall("GET", "/api/v1/topics?limit=20")
st, b = bt_http.jcall("GET", "/api/v1/topics?limit=20&q=%E5%AD%98%E6%A1%A3")   # 存档
st, c = bt_http.jcall("GET", "/api/v1/topics?limit=20&q=zzzz-no-such-word-zzzz")
out["q_filter"] = {"all": len(a.get("data") or []), "q=存档": len(b.get("data") or []),
                   "q=zzzz": len(c.get("data") or []),
                   "q_returns": [t.get("title") for t in (b.get("data") or [])][:6]}
# 4) 帖子详情正文长度 + 字段
ts = (a.get("data") or [])
if ts:
    tid = ts[0]["id"]
    st, d = bt_http.jcall("GET", "/api/v1/topics/" + tid)
    dd = d.get("data") or {}
    out["topic_detail"] = {"keys": sorted(dd.keys()), "title": dd.get("title"),
        "content_html": dd.get("content_html"), "content_md": (dd.get("content_md") or "")[:120],
        "excerpt": dd.get("excerpt"), "images": dd.get("images"), "sources": dd.get("sources"),
        "author": {k: dd.get("author", {}).get(k) for k in ("handle","nickname","bio","level","joined_at")}}
# 5) 用户详情字段
st, u = bt_http.jcall("GET", "/api/v1/users/Alenger")
out["user_detail"] = {"keys": sorted((u.get("data") or {}).keys()), "data": u.get("data")}
# 6) /me 字段与前端 Session 类型对比
st, me = bt_http.jcall("GET", "/api/v1/me")
front = ["id","handle","nickname","avatar","email_verified","bio","perms","board_ids","is_super","wallet_cents","unread_count","extra","role","activated_at"]
have = me.get("data") or {}
out["me_vs_frontend"] = {"backend_keys": sorted(have.keys()),
    "frontend_expects_missing": [k for k in front if k not in have]}
# 7) post.create / topic.create 权限（发帖页读的那个）
out["perms"] = have.get("perms")
# 8) notifications 形状（前端期望 items 每项 id/kind/summary/read/created_at）
st, nf = bt_http.jcall("GET", "/api/v1/notifications")
out["notifications"] = {"status": st, "keys": sorted(nf.keys()), "count": len(nf.get("data") or [])}
# 9) site 形状（前端要 announcements[].id/title/created_at, banner{id,text}）
st, si = bt_http.jcall("GET", "/api/v1/site")
out["site"] = si
# 10) boards 形状（前端要 cover/topic_count/post_count/member_count/today_count）
st, bd = bt_http.jcall("GET", "/api/v1/boards")
out["boards_first"] = (bd.get("data") or [{}])[0]
with open(r"D:\Code\Rust\SC2clud\shots\blindtest\_api-shapes.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("written")

import sys, json
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, info = bt_http.login()
st, boards = bt_http.jcall("GET", "/api/v1/boards")
st2, topics = bt_http.jcall("GET", "/api/v1/topics?limit=3")
print(json.dumps({
  "boards_status": st, "boards": [b.get("slug") for b in (boards.get("data") or [])],
  "topics_status": st2, "topics": [{"id": t.get("id"), "title": t.get("title"), "author": (t.get("author") or {}).get("handle")} for t in (topics.get("data") or [])],
}, ensure_ascii=False))

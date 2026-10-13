#!/usr/bin/env python3
"""接口可用性矩阵：逐条打真实请求，断言 JSON 形状与关键字段非空。

只做只读（GET）与一条登录（POST /auth/login）；不写库、不改别人的数据。
证据写进 JSON 文件（终端只看得到 GBK，中文会花掉 —— 所以结论一律落盘再由报告读取）。
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bt_http

OUT = r"D:\Code\Rust\SC2clud\shots\blindtest"
rows = []

def rec(name, method, path, status, ok, detail, body=None, sent=None):
    rows.append({"name": name, "method": method, "path": sent or path, "status": status,
                 "ok": bool(ok), "detail": detail, "sample": (json.dumps(body, ensure_ascii=False)[:600] if body is not None else None)})

def nonempty(v):
    return v not in (None, "", [], {})

def need_shape(shape, body, path="data"):
    """按 (键, 判据) 列表检查；返回缺失/为空的字段名列表。"""
    cur = body
    bad = []
    for k, judge in shape:
        if isinstance(cur, dict) and k in cur:
            v = cur[k]
        else:
            v = None
        if judge == "nonempty" and not nonempty(v):
            bad.append(k)
        elif judge == "present" and (isinstance(cur, dict) and k not in cur):
            bad.append(k + "(缺失)")
        elif callable(judge) and not judge(v):
            bad.append(k)
    return bad

def main():
    ok, info = bt_http.login()
    rec("登录 POST /auth/login", "POST", "/api/v1/auth/login", 200 if ok else 0, ok,
        "probe-admin 登录成功" if ok else json.dumps(info, ensure_ascii=False)[:300])
    if not ok:
        json.dump(rows, open(os.path.join(OUT, "_api.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return

    # ---------- 站点/会话 ----------
    st, b = bt_http.jcall("GET", "/api/v1/site")
    bad = need_shape([("name", "nonempty"), ("announcements", lambda v: isinstance(v, list))], b.get("data"))
    rec("站点信息 GET /site", "GET", "/api/v1/site", st, st == 200 and not bad, "缺/空字段: " + ",".join(bad) if bad else "name=%s announcements=%d" % (b["data"]["name"], len(b["data"]["announcements"])), b)

    st, b = bt_http.jcall("GET", "/api/v1/me")
    d = b.get("data") or {}
    bad = need_shape([("handle", "nonempty"), ("nickname", "nonempty")], d)
    rec("当前会话 GET /me", "GET", "/api/v1/me", st, st == 200 and not bad, "缺/空字段: " + ",".join(bad) if bad else "handle=%s" % d["handle"], b)

    st, b = bt_http.jcall("GET", "/api/v1/healthz")
    d = b if isinstance(b, dict) else {}
    rec("健康探针 GET /healthz (无 /api/v1 前缀)", "GET", "/healthz", st, st == 200 and nonempty(d.get("status")),
        "status=%s version=%s" % (d.get("status"), d.get("version")), b)

    st, b = bt_http.jcall("GET", "/api/v1/captcha")
    d = b.get("data") or {}
    rec("图形验证码 GET /captcha", "GET", "/api/v1/captcha", st, st == 200 and nonempty(d.get("id")) and str(d.get("image_base64", "")).startswith("data:image"),
        "id=%s image=%d 字节" % (d.get("id"), len(str(d.get("image_base64", "")))) if st == 200 else str(b)[:200], {"id": d.get("id"), "image_base64_len": len(str(d.get("image_base64",""))) } if st == 200 else b)

    # ---------- 论坛 ----------
    st, b = bt_http.jcall("GET", "/api/v1/boards")
    bs = b.get("data") or []
    bad = [x.get("slug") for x in bs if not nonempty(x.get("slug")) or not nonempty(x.get("name"))]
    rec("分区列表 GET /boards", "GET", "/api/v1/boards", st, st == 200 and len(bs) > 0 and not bad,
        "分区数=%d slug=%s" % (len(bs), ",".join(x.get("slug","") for x in bs)) if st == 200 else str(b)[:200], {"count": len(bs), "slugs": [x.get("slug") for x in bs]})
    slugs = [x.get("slug") for x in bs if x.get("slug")]

    for slug in slugs:
        st, b = bt_http.jcall("GET", "/api/v1/boards/" + slug)
        d = b.get("data") or {}
        bad = need_shape([("slug", "nonempty"), ("name", "nonempty")], d)
        rec("分区详情 GET /boards/%s" % slug, "GET", "/api/v1/boards/" + slug, st, st == 200 and not bad,
            "缺/空: " + ",".join(bad) if bad else "name=%s topic_count=%s" % (d.get("name"), d.get("topic_count")), b)

    st, b = bt_http.jcall("GET", "/api/v1/topics?limit=5")
    ts = b.get("data") or []
    bad = [t.get("id") for t in ts if not nonempty(t.get("title")) or not nonempty(t.get("id")) or not nonempty((t.get("author") or {}).get("handle"))]
    rec("帖子列表 GET /topics", "GET", "/api/v1/topics?limit=5", st,
        st == 200 and len(ts) > 0 and not bad and "next_cursor" in b,
        "条数=%d next_cursor=%r 空字段帖=%s" % (len(ts), b.get("next_cursor"), bad) if st == 200 else str(b)[:200],
        {"count": len(ts), "next_cursor": b.get("next_cursor"), "first": {k: ts[0].get(k) for k in ("id","title","reply_count","like_count","view_count")} if ts else None})

    for extra, label in [("sort=new", "sort=new"), ("sort=hot", "sort=hot"), ("kind=resource", "kind=resource"), ("q=%E5%AD%98%E6%A1%A3", "q=存档")]:
        st, b = bt_http.jcall("GET", "/api/v1/topics?limit=3&" + extra)
        d = b.get("data")
        rec("帖子列表过滤 GET /topics?%s" % label, "GET", "/api/v1/topics?limit=3&" + extra, st,
            st == 200 and isinstance(d, list), "条数=%s" % (len(d) if isinstance(d, list) else "非列表"), {"count": len(d) if isinstance(d, list) else None})

    if ts:
        tid = ts[0]["id"]
        st, b = bt_http.jcall("GET", "/api/v1/topics/" + tid)
        d = b.get("data") or {}
        bad = need_shape([("id", "nonempty"), ("title", "nonempty"), ("content_html", "nonempty"), ("author", "nonempty"), ("board", "nonempty")], d)
        rec("帖子详情 GET /topics/{id}", "GET", "/api/v1/topics/" + tid, st, st == 200 and not bad,
            "缺/空: " + ",".join(bad) if bad else "title=%s content_html=%d 字节" % (d.get("title"), len(d.get("content_html",""))), b)
        have_excerpt = "excerpt" in d
        rec("帖子详情 excerpt 字段（列表页要用的摘要）", "GET", "/api/v1/topics/" + tid, st, have_excerpt,
            "详情里有 excerpt" if have_excerpt else "详情响应没有 excerpt 字段（前端 types 里标着待后端补）", {"keys": sorted(d.keys())})

        st, b = bt_http.jcall("GET", "/api/v1/topics/" + tid + "/posts?limit=5")
        ps = b.get("data") or []
        bad = [p.get("id") for p in ps if not nonempty(p.get("id")) or not nonempty(p.get("content_html")) or not nonempty((p.get("author") or {}).get("handle"))]
        rec("回复列表 GET /topics/{id}/posts", "GET", "/api/v1/topics/" + tid + "/posts?limit=5", st,
            st == 200 and not bad and (len(ps) > 0),
            "条数=%d 空字段=%s next_cursor=%r" % (len(ps), bad, b.get("next_cursor")) if st == 200 else str(b)[:200],
            {"count": len(ps), "content_len": [len(p.get("content_html","")) for p in ps[:3]]})

    st, b = bt_http.jcall("GET", "/api/v1/topics?limit=5&sort=latest")
    if st == 200 and (b.get("data") or []):
        t2 = b["data"][0]
        rec("列表项 excerpt（卡片/紧凑列表要的摘要）", "GET", "/api/v1/topics?limit=5&sort=latest", st,
            "excerpt" in t2 and nonempty(t2.get("excerpt")),
            ("excerpt 非空，%d 字" % len(t2.get("excerpt") or "")) if nonempty(t2.get("excerpt")) else ("有 excerpt 字段但为空" if "excerpt" in t2 else "列表项根本没有 excerpt 字段"),
            {"keys": sorted(t2.keys())})

    # ---------- 用户 ----------
    handle = None
    st, b = bt_http.jcall("GET", "/api/v1/topics?limit=5")
    for t in (b.get("data") or []):
        h = (t.get("author") or {}).get("handle")
        if h and h != "probe-admin":
            handle = h
            break
    handle = handle or "probe-admin"
    st, b = bt_http.jcall("GET", "/api/v1/users/" + handle)
    d = b.get("data") or {}
    bad = need_shape([("handle", "nonempty"), ("nickname", "nonempty")], d)
    rec("个人主页 GET /users/{handle}", "GET", "/api/v1/users/" + handle, st, st == 200 and not bad,
        "缺/空: " + ",".join(bad) if bad else "nickname=%s stats=%s" % (d.get("nickname"), bool(d.get("stats"))), b)
    rec("个人主页 stats（作品/回复/获赞/关注）", "GET", "/api/v1/users/" + handle, st, nonempty(d.get("stats")),
        "stats=%s" % json.dumps(d.get("stats"), ensure_ascii=False) if d.get("stats") else "没有 stats 字段（个人主页的统计区拿不到数）", {"stats": d.get("stats")})

    st, b = bt_http.jcall("GET", "/api/v1/users/" + handle + "/topics?limit=5")
    d = b.get("data")
    rec("个人主页作品列表 GET /users/{handle}/topics", "GET", "/api/v1/users/" + handle + "/topics?limit=5", st,
        st == 200 and isinstance(d, list), "条数=%s" % (len(d) if isinstance(d, list) else "非列表"), {"count": len(d) if isinstance(d, list) else None})

    # ---------- 通知 ----------
    st, b = bt_http.jcall("GET", "/api/v1/notifications?limit=5")
    d = b.get("data")
    rec("通知列表 GET /notifications", "GET", "/api/v1/notifications?limit=5", st, st == 200 and isinstance(d, list),
        "条数=%s" % (len(d) if isinstance(d, list) else "非列表"), {"count": len(d) if isinstance(d, list) else None})
    st, b = bt_http.jcall("GET", "/api/v1/notifications/unread-count")
    d = b.get("data") or {}
    rec("未读数 GET /notifications/unread-count", "GET", "/api/v1/notifications/unread-count", st,
        st == 200 and isinstance(d.get("count"), int), "count=%s" % d.get("count"), b)

    # ---------- 负面用例：不存在的资源必须 404 JSON ----------
    for label, path in [("不存在的帖子", "/api/v1/topics/00000000-0000-0000-0000-000000000000"),
                        ("不存在的分区", "/api/v1/boards/no-such-board-xyz"),
                        ("不存在的用户", "/api/v1/users/no-such-user-xyz"),
                        ("不存在的接口", "/api/v1/no-such-endpoint-xyz"),
                        ("未实现的 search 契约端点", "/api/v1/search?q=a&type=topics"),
                        ("未实现的 messages 契约端点", "/api/v1/messages"),
                        ("未实现的 launcher 契约端点", "/api/v1/launcher/latest")]:
        st, hd, tx = bt_http.call("GET", path)
        ct = hd.get("Content-Type", "")
        is_json = "application/json" in ct
        code = None
        try:
            code = json.loads(tx).get("error", {}).get("code")
        except Exception:
            pass
        okrow = (st == 404) and is_json and bool(code)
        rec(label, "GET", path, st, okrow,
            "404 + JSON error.code=%s" % code if okrow else "status=%s content-type=%s code=%s body=%.80s" % (st, ct, code, tx.replace("\n", " ")),
            {"status": st, "content_type": ct, "error_code": code, "body": tx[:200]})

    # ---------- 认证边界（只读） ----------
    bt_http.reset_session()
    for label, path in [("未登录 GET /me", "/api/v1/me"),
                        ("未登录 GET /notifications", "/api/v1/notifications")]:
        st, hd, tx = bt_http.call("GET", path)
        try:
            j = json.loads(tx)
        except Exception:
            j = None
        okrow = st == 200 if path.endswith("/me") else st in (401, 403)
        rec(label, "GET", path, st, okrow, "status=%s body=%.120s" % (st, tx.replace("\n", " ")), j)
    ok2, info2 = bt_http.login()   # 恢复会话（重新登录一次）

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "_api.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print("api checks:", len(rows), "fail:", sum(1 for r in rows if not r["ok"]))

main()

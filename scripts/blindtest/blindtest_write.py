#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SC2clud 盲测 —— 写操作主链路（13 步）。

跑在 dev 服务器上（nginx 只监听 191.40.41.97，用 Host 头打到 /dev）。
只用 probe-admin，自己造的行带 [盲测] 标记，跑完清理。

用法:
  python3 blindtest_write.py            # 跑全部
  python3 blindtest_write.py --json     # 末尾多打一行 BT_JSON:{...} 给上层解析
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, uuid

HOST_HEADER = os.environ.get("BT_HOST", "191.40.41.97")
BASE = os.environ.get("BT_BASE", "http://127.0.0.1/dev")
USER = os.environ.get("BT_USER", "probe-admin")
PASS = os.environ.get("BT_PASS", "Probe-Dev-2026!")
BOARD = os.environ.get("BT_BOARD", "custom-campaign")
MARK = "[盲测]"

RESULTS = []
FAILS = []
EVIDENCE = []


class Resp(object):
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        try:
            return json.loads(self.body)
        except Exception:
            return None


class Client(object):
    def __init__(self):
        self.cookie = ""

    def req(self, method, path, body=None, cookie=None):
        url = BASE + path
        data = None
        headers = {"Host": HOST_HEADER, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        ck = self.cookie if cookie is None else cookie
        if ck:
            headers["Cookie"] = ck
        r = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return Resp(resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            return Resp(e.code, dict(e.headers), e.read().decode("utf-8", "replace"))

    def get(self, p, cookie=None):
        return self.req("GET", p, None, cookie)

    def post(self, p, b=None):
        return self.req("POST", p, b)

    def put(self, p, b=None):
        return self.req("PUT", p, b)

    def patch(self, p, b=None):
        return self.req("PATCH", p, b)

    def delete(self, p):
        return self.req("DELETE", p)

    def set_cookie_from(self, r):
        sc = r.headers.get("Set-Cookie") or r.headers.get("set-cookie") or ""
        if sc:
            self.cookie = sc.split(";")[0]


def rcli(*args):
    try:
        return subprocess.check_output(["redis-cli"] + list(args), stderr=subprocess.STDOUT).decode("utf-8", "replace").strip()
    except Exception as e:
        return "__ERR__" + str(e)


def ev(line):
    EVIDENCE.append(line)
    print("      | " + line)


def check(step, name, ok, detail=""):
    """一条断言。ok=True 计入通过，否则算失败。"""
    RESULTS.append({"step": step, "name": name, "ok": bool(ok), "detail": detail})
    print("   [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  -- " + detail) if detail else ""))
    if not ok:
        FAILS.append({"step": step, "name": name, "detail": detail})
    return bool(ok)


def short(s, n=300):
    if s is None:
        return "<none>"
    s = str(s)
    return s if len(s) <= n else s[:n] + "...(truncated)"


def errcode(r):
    j = r.json()
    if isinstance(j, dict) and isinstance(j.get("error"), dict):
        return j["error"].get("code")
    return None


def d(r):
    j = r.json()
    if isinstance(j, dict) and "data" in j:
        return j["data"]
    return None


def get_captcha():
    return d(Client().get("/api/v1/captcha"))


def login(cl, user=USER, pw=PASS):
    cap = get_captcha()
    if not cap or not cap.get("id"):
        return None, "captcha 取不到"
    cid = cap["id"]
    ans = rcli("get", "captcha:" + cid)
    r = cl.post("/api/v1/auth/login", {"login": user, "password": pw,
                                       "captcha_id": cid, "captcha_answer": ans})
    return r, cid


# ============================ 检查辅助 ============================

def find_topic(cl, tid, limit=50):
    """在列表里查主题（只看第一页，够用）。"""
    r = cl.get("/api/v1/topics?limit=%d" % limit)
    items = d(r) or []
    for t in items:
        if t.get("id") == tid:
            return t
    return None


def topic_posts(cl, tid, limit=50):
    r = cl.get("/api/v1/topics/%s/posts?limit=%d" % (tid, limit))
    return d(r) or []


def cleanup_rows(cl, tid, pid):
    """清理：自己造的行只按 id 删（主题删掉会级联 posts / bookmarks）。"""
    out = {}
    if pid:
        r = cl.delete("/api/v1/posts/%s" % pid)
        out["delete_post"] = r.status
    if tid:
        r = cl.delete("/api/v1/topics/%s" % tid)
        out["delete_topic"] = r.status
    return out


# ============================ 主流程 ============================

def main():
    cl = Client()
    state = {}
    t0 = time.time()

    print("=" * 72)
    print("SC2clud 盲测 · 写操作主链路  base=%s host=%s user=%s" % (BASE, HOST_HEADER, USER))
    print("=" * 72)

    # ---------- 1 登录 ----------
    print("\n[1] 登录（验证码 -> login -> /me）")
    r, cid = login(cl)
    ev("GET /api/v1/captcha -> id=%s" % cid)
    ev("redis-cli get captcha:%s -> %r" % (cid, rcli("get", "captcha:" + cid)))
    if r is None:
        check(1, "取到验证码并提交登录", False, "captcha 端点没返回 id")
        return finish(state, t0)
    cl.set_cookie_from(r)
    ev("POST /api/v1/auth/login -> HTTP %d, cookie=%s, body=%s" % (r.status, short(cl.cookie, 60), short(r.body, 200)))
    check(1, "登录返回 200", r.status == 200, short(r.body, 200))
    lj = d(r) or {}
    me_handle = (lj.get("user") or {}).get("handle") or lj.get("handle")
    check(1, "登录响应里是 probe-admin", me_handle == USER, "handle=%r" % me_handle)

    r = cl.get("/api/v1/me")
    me = d(r) or {}
    ev("GET /api/v1/me -> HTTP %d body=%s" % (r.status, short(r.body, 300)))
    check(1, "/me 是本人（handle=%s）" % USER, me.get("handle") == USER, "handle=%r" % me.get("handle"))
    state["my_id"] = me.get("id")

    # ---------- 2 发主题 ----------
    print("\n[2] 发主题（标题带 %s）" % MARK)
    token = "bt-" + uuid.uuid4().hex[:16]
    title = "%s自动化主链路 %s" % (MARK, time.strftime("%H%M%S"))
    body = "这是盲测脚本造的正文，用于验证发主题链路。socket=%s" % token
    r = cl.post("/api/v1/topics", {"board": BOARD, "kind": "discussion", "title": title,
                                   "content_md": body, "client_token": token})
    ev("POST /api/v1/topics -> HTTP %d body=%s" % (r.status, short(r.body, 400)))
    check(2, "发主题返回 201", r.status == 201, short(r.body, 300))
    tj = d(r) or {}
    tid = tj.get("id")
    state["tid"], state["title"], state["body"] = tid, title, body
    check(2, "返回体里有主题 id", bool(tid), "id=%r" % tid)

    if tid:
        got = cl.get("/api/v1/topics/%s" % tid)
        gj = d(got) or {}
        ev("GET /api/v1/topics/%s -> HTTP %d title=%r" % (tid, got.status, gj.get("title")))
        check(2, "详情里能查到这篇（按 id）", gj.get("title") == title, "title=%r" % gj.get("title"))

        found = find_topic(cl, tid)
        ev("GET /api/v1/topics?limit=50 -> 命中=%s" % (found is not None))
        check(2, "列表里能查到这篇", found is not None, "在首页 50 条里没找到 id=%s" % tid)
        if found:
            check(2, "列表里的标题一致", found.get("title") == title, "title=%r" % found.get("title"))

    # ---------- 3 回复 ----------
    print("\n[3] 回复主题")
    if not tid:
        check(3, "回复（依赖第 2 步拿到 tid）", False, "第 2 步没拿到 tid，跳过")
        pid = None
    else:
        r = cl.post("/api/v1/topics/%s/posts" % tid,
                    {"content_md": "盲测一级回复 %s" % token, "client_token": token + "-r1"})
        ev("POST /api/v1/topics/%s/posts -> HTTP %d body=%s" % (tid, r.status, short(r.body, 400)))
        check(3, "回复返回 201", r.status == 201, short(r.body, 300))
        pj = d(r) or {}
        pid = pj.get("id")
        check(3, "回复体里有 id", bool(pid), "id=%r" % pid)
        check(3, "回复体里 parent_id 为空", not pj.get("parent_id"), "parent_id=%r" % pj.get("parent_id"))
        posts = topic_posts(cl, tid)
        ev("GET /topics/%s/posts -> %d 条, floors=%s" % (tid, len(posts), [p.get("floor") for p in posts]))
        check(3, "楼层数 = 2（1 楼主帖 + 1 回复）", len(posts) == 2, "实际 %d 条" % len(posts))
        mine = [p for p in posts if p.get("id") == pid]
        check(3, "回复的 floor 是 2", bool(mine) and mine[0].get("floor") == 2,
              "floor=%r" % (mine[0].get("floor") if mine else None))
        detail = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        ev("主题 reply_count=%r" % detail.get("reply_count"))
        check(3, "主题 reply_count = 1", detail.get("reply_count") == 1, "reply_count=%r" % detail.get("reply_count"))
    state["pid"] = pid

    # ---------- 4 楼中楼 ----------
    print("\n[4] 楼中楼（只允许一级）")
    cid2 = None
    if not (tid and pid):
        check(4, "楼中楼（依赖第 3 步的 pid）", False, "缺 tid/pid，跳过")
    else:
        r = cl.post("/api/v1/topics/%s/posts" % tid,
                    {"content_md": "盲测楼中楼 %s" % token, "parent_id": pid, "client_token": token + "-r2"})
        ev("POST posts(parent_id=%s) -> HTTP %d body=%s" % (pid, r.status, short(r.body, 400)))
        check(4, "回复「回复」返回 201", r.status == 201, short(r.body, 300))
        cj = d(r) or {}
        cid2 = cj.get("id")
        check(4, "楼中楼 parent_id 非空", bool(cj.get("parent_id")), "parent_id=%r" % cj.get("parent_id"))
        replies = d(cl.get("/api/v1/posts/%s/replies" % pid)) or []
        ev("GET /posts/%s/replies -> %d 条: %s" % (pid, len(replies), [x.get("id") for x in replies]))
        check(4, "楼中楼挂在父回复下（/posts/{pid}/replies 能看到）",
              any(x.get("id") == cid2 for x in replies), "没在父回复的子列表里找到 %s" % cid2)

        r2 = cl.post("/api/v1/topics/%s/posts" % tid,
                     {"content_md": "盲测三级回复（应被拒）%s" % token, "parent_id": cid2,
                      "client_token": token + "-r3"})
        ev("POST posts(parent_id=<楼中楼 %s>) -> HTTP %d body=%s" % (cid2, r2.status, short(r2.body, 400)))
        check(4, "对楼中楼再回复一级被拒（4xx）", 400 <= r2.status < 500, "HTTP %d" % r2.status)
        check(4, "被拒时有结构化的错误码", bool(errcode(r2)), "code=%r" % errcode(r2))
        posts = topic_posts(cl, tid)
        ev("此后楼层数=%d" % len(posts))
        check(4, "被拒后没有多出楼层", len(posts) == 3, "实际 %d 条" % len(posts))
    state["cid"] = cid2

    # ---------- 5 点赞 / 取消（幂等） ----------
    print("\n[5] 点赞 / 取消点赞（计数 + 幂等）")
    if not tid:
        check(5, "点赞（依赖 tid）", False, "缺 tid，跳过")
    else:
        base_cnt = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("like_count")
        ev("起始 like_count=%r" % base_cnt)
        r = cl.put("/api/v1/topics/%s/like" % tid)
        c1 = (d(r) or {}).get("like_count")
        ev("PUT like #1 -> HTTP %d body=%s" % (r.status, short(r.body, 200)))
        check(5, "点赞返回 200", r.status == 200, "HTTP %d" % r.status)
        check(5, "点赞后计数 +1", c1 == (base_cnt or 0) + 1, "%r -> %r" % (base_cnt, c1))
        r = cl.put("/api/v1/topics/%s/like" % tid)
        c2 = (d(r) or {}).get("like_count")
        ev("PUT like #2（幂等）-> HTTP %d like_count=%r" % (r.status, c2))
        check(5, "重复点赞幂等（计数不变）", c2 == c1, "%r -> %r" % (c1, c2))
        dt = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        check(5, "详情里的 like_count 与响应一致", dt.get("like_count") == c2, "%r vs %r" % (dt.get("like_count"), c2))

        r = cl.delete("/api/v1/topics/%s/like" % tid)
        c3 = (d(r) or {}).get("like_count")
        ev("DELETE like #1 -> HTTP %d like_count=%r" % (r.status, c3))
        check(5, "取消点赞后计数 -1", c3 == (c2 or 0) - 1, "%r -> %r" % (c2, c3))
        r = cl.delete("/api/v1/topics/%s/like" % tid)
        c4 = (d(r) or {}).get("like_count")
        ev("DELETE like #2（幂等）-> HTTP %d like_count=%r" % (r.status, c4))
        check(5, "重复取消幂等（计数不变、不为负）", c4 == c3 and (c4 or 0) >= 0, "%r -> %r" % (c3, c4))

    # ---------- 6 收藏 / 取消 ----------
    print("\n[6] 收藏 / 取消收藏（/me/bookmarks）")
    if not tid:
        check(6, "收藏（依赖 tid）", False, "缺 tid，跳过")
    else:
        def in_bookmarks():
            r = cl.get("/api/v1/me/bookmarks?limit=50")
            return d(r) or [], r.status

        r = cl.put("/api/v1/topics/%s/bookmark" % tid)
        ev("PUT bookmark -> HTTP %d body=%s" % (r.status, short(r.body, 200)))
        check(6, "收藏返回 200", r.status == 200, "HTTP %d" % r.status)
        items, st = in_bookmarks()
        hit = [x for x in items if (x.get("id") == tid or (x.get("topic") or {}).get("id") == tid)]
        ev("GET /me/bookmarks -> HTTP %d, %d 条, 命中=%s" % (st, len(items), bool(hit)))
        check(6, "收藏后 /me/bookmarks 里能看到", bool(hit), "没找到 topic %s" % tid)

        r = cl.delete("/api/v1/topics/%s/bookmark" % tid)
        ev("DELETE bookmark -> HTTP %d" % r.status)
        check(6, "取消收藏返回 200", r.status == 200, "HTTP %d" % r.status)
        items, st = in_bookmarks()
        hit = [x for x in items if (x.get("id") == tid or (x.get("topic") or {}).get("id") == tid)]
        ev("再看 /me/bookmarks -> %d 条, 命中=%s" % (len(items), bool(hit)))
        check(6, "取消后 /me/bookmarks 里消失", not hit, "仍在列表里")

    # ---------- 7 编辑主题 ----------
    print("\n[7] 编辑自己的主题（正文 + updated_at）")
    if not tid:
        check(7, "编辑主题（依赖 tid）", False, "缺 tid，跳过")
    else:
        before = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        u0 = before.get("updated_at")
        ev("编辑前 title=%r updated_at=%s" % (before.get("title"), u0))
        time.sleep(1.1)  # 有的库 updated_at 精度到秒；睡一下免得误判
        new_title = title + "（已编辑）"
        new_body = body + " —— 编辑后的正文标记 " + token
        r = cl.patch("/api/v1/topics/%s" % tid, {"title": new_title, "content_md": new_body})
        ev("PATCH /topics/%s -> HTTP %d body=%s" % (tid, r.status, short(r.body, 300)))
        check(7, "编辑返回 2xx", 200 <= r.status < 300, "HTTP %d" % r.status)
        after = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        ev("编辑后 title=%r updated_at=%s" % (after.get("title"), after.get("updated_at")))
        check(7, "标题真的变了", after.get("title") == new_title, "title=%r" % after.get("title"))
        check(7, "updated_at 变了", after.get("updated_at") != u0, "%r -> %r" % (u0, after.get("updated_at")))
        # 正文在 1 楼的 content_md 里
        posts = topic_posts(cl, tid)
        first = posts[0] if posts else {}
        ev("1 楼 content_md=%s" % short(first.get("content_md"), 160))
        check(7, "正文真的变了（1 楼 content_md 含新增标记）",
              token in (first.get("content_md") or "") and "编辑后的正文标记" in (first.get("content_md") or ""),
              short(first.get("content_md"), 200))
        state["title"] = new_title
        state["body"] = new_body

    # ---------- 10 个人主页（提前做，免得清理把数据删没了） ----------
    print("\n[10] 个人主页 /u/probe-admin 能看到刚发的主题")
    if not tid:
        check(10, "个人主页（依赖 tid）", False, "缺 tid，跳过")
    else:
        r = cl.get("/api/v1/users/%s" % USER)
        pj = d(r) or {}
        ev("GET /api/v1/users/%s -> HTTP %d topic_count=%r" % (USER, r.status, pj.get("topic_count")))
        check(10, "主页返回 200", r.status == 200, "HTTP %d" % r.status)
        check(10, "主页 topic_count >= 1", (pj.get("topic_count") or 0) >= 1, "topic_count=%r" % pj.get("topic_count"))
        r = cl.get("/api/v1/users/%s/topics?limit=50" % USER)
        items = d(r) or []
        hit = [x for x in items if x.get("id") == tid]
        ev("GET /users/%s/topics -> HTTP %d, %d 条, 命中=%s" % (USER, r.status, len(items), bool(hit)))
        check(10, "主页作品列表里能看到刚发的主题", bool(hit), "没找到 %s" % tid)
        if hit:
            check(10, "主页里的标题是编辑后的", hit[0].get("title") == state.get("title"), "title=%r" % hit[0].get("title"))
        # 页面本体（HTML 壳）
        r = cl.get("/u/%s" % USER)
        ev("GET /u/%s (HTML) -> HTTP %d, %d 字节" % (USER, r.status, len(r.body or "")))
        check(10, "/u/probe-admin 页面可访问", r.status == 200 and len(r.body or "") > 0, "HTTP %d" % r.status)

    # ---------- 8 举报 ----------
    print("\n[8] 举报一条内容（要有可观察回执）")
    if not tid:
        check(8, "举报（依赖 tid）", False, "缺 tid，跳过")
    else:
        r = cl.post("/api/v1/reports", {"target_type": "topic", "target_id": tid,
                                        "reason": "other", "detail": "盲测脚本造的举报 " + token})
        ev("POST /reports -> HTTP %d body=%s" % (r.status, short(r.body, 500)))
        check(8, "举报返回 201", r.status == 201, "HTTP %d %s" % (r.status, short(r.body, 200)))
        rj = d(r) or {}
        check(8, "回执里有举报 id", bool(rj.get("id")), "id=%r" % rj.get("id"))
        check(8, "回执里 created=true", rj.get("created") is True, "created=%r" % rj.get("created"))
        check(8, "回执里能看出举报的是哪条", rj.get("target_id") == tid, "target_id=%r" % rj.get("target_id"))
        check(8, "回执里有 state", bool(rj.get("state")), "state=%r" % rj.get("state"))
        r = cl.post("/api/v1/reports", {"target_type": "topic", "target_id": tid,
                                        "reason": "other", "detail": "盲测脚本重复举报 " + token})
        rj2 = d(r) or {}
        ev("POST /reports 重复 -> HTTP %d, created=%r, id=%r" % (r.status, rj2.get("created"), rj2.get("id")))
        check(8, "重复举报幂等（200 + 既有那条）",
              r.status == 200 and rj2.get("created") is False and rj2.get("id") == rj.get("id"),
              "HTTP %d created=%r" % (r.status, rj2.get("created")))
        r = cl.get("/api/v1/me/reports?limit=50")
        items = d(r) or []
        hit = [x for x in items if x.get("id") == rj.get("id")]
        ev("GET /me/reports -> HTTP %d, %d 条, 命中=%s" % (r.status, len(items), bool(hit)))
        check(8, "「我的举报」列表里能看到这条", bool(hit), "没找到 %s" % rj.get("id"))
        state["rid"] = rj.get("id")

    # ---------- 9 删除自己的回复 ----------
    print("\n[9] 删除自己的回复（计数 -1、列表里少一条）")
    if not (tid and cid2):
        check(9, "删除回复（依赖第 4 步的楼中楼）", False, "缺 tid/cid，跳过")
    else:
        posts_before = topic_posts(cl, tid)
        n_before = len(posts_before)
        rc_before = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        r = cl.delete("/api/v1/posts/%s" % cid2)
        ev("DELETE /posts/%s -> HTTP %d" % (cid2, r.status))
        check(9, "删除返回 204", r.status == 204, "HTTP %d" % r.status)
        posts_after = topic_posts(cl, tid)
        rc_after = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        ev("楼层 %d -> %d；reply_count %r -> %r" % (n_before, len(posts_after), rc_before, rc_after))
        check(9, "列表里少一条", len(posts_after) == n_before - 1, "%d -> %d" % (n_before, len(posts_after)))
        check(9, "被删的那条不在列表里", not any(p.get("id") == cid2 for p in posts_after), "还在")
        check(9, "主题 reply_count -1", rc_after == (rc_before or 0) - 1, "%r -> %r" % (rc_before, rc_after))
        state["cid"] = None

    # ---------- 11 未登录 ----------
    print("\n[11] 未登录访问需要登录的操作 -> 明确 401/403")
    anon = Client()  # 不带 cookie
    anon_cases = [
        ("PUT", "/api/v1/topics/%s/like" % (tid or "00000000-0000-0000-0000-000000000000"), None),
        ("PUT", "/api/v1/topics/%s/bookmark" % (tid or "00000000-0000-0000-0000-000000000000"), None),
        ("POST", "/api/v1/topics", {"board": BOARD, "kind": "discussion", "title": MARK + "未登录发帖", "content_md": "x"}),
        ("POST", "/api/v1/reports", {"target_type": "topic", "target_id": tid or "00000000-0000-0000-0000-000000000000",
                                     "reason": "other", "detail": "未登录举报"}),
        ("GET", "/api/v1/me/bookmarks", None),
        ("GET", "/api/v1/me/reports", None),
        ("DELETE", "/api/v1/topics/%s" % (tid or "00000000-0000-0000-0000-000000000000"), None),
    ]
    for method, path, body in anon_cases:
        r = anon.req(method, path, body)
        code = errcode(r)
        ok = r.status in (401, 403) and bool(code)
        ev("匿名 %s %s -> HTTP %d code=%r" % (method, path, r.status, code))
        check(11, "匿名 %s %s 明确 401/403" % (method, path.split("?")[0]),
              ok, "HTTP %d code=%r body=%s" % (r.status, code, short(r.body, 160)))
    # DELETE 未登录不该真的删掉东西
    if tid:
        still = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        check(11, "匿名 DELETE 没真的删掉主题", still.get("title") == state.get("title"),
              "主题现在 title=%r" % still.get("title"))

    # ---------- 12 错口令 / 重复用验证码 ----------
    print("\n[12] 错口令登录 / 重复用同一张验证码 -> 明确错误码")
    # 12a 先取一张题，故意填错答案，再拿同一张题重放
    cap = get_captcha()
    if not cap:
        check(12, "取验证码", False, "captcha 端点没返回 id")
    else:
        cid_bad = cap["id"]
        ans_bad = rcli("get", "captcha:" + cid_bad)
        ev("题目 id=%s 正确答案=%r" % (cid_bad, ans_bad))
        r1 = Client().post("/api/v1/auth/login", {"login": USER, "password": PASS,
                                                  "captcha_id": cid_bad, "captcha_answer": "ZZZZ"})
        ev("第 1 次（错误答案 ZZZZ）-> HTTP %d code=%r body=%s" % (r1.status, errcode(r1), short(r1.body, 200)))
        check(12, "错误验证码被拒（4xx + 错误码）",
              r1.status in (400, 401, 403, 422, 429) and bool(errcode(r1)),
              "HTTP %d code=%r" % (r1.status, errcode(r1)))
        check(12, "错误验证码没有发会话 cookie",
              not (r1.headers.get("Set-Cookie") or ""), "Set-Cookie=%r" % short(r1.headers.get("Set-Cookie"), 80))
        r2 = Client().post("/api/v1/auth/login", {"login": USER, "password": PASS,
                                                  "captcha_id": cid_bad, "captcha_answer": ans_bad})
        ev("第 2 次（同一张题的正确回答）-> HTTP %d code=%r body=%s" % (r2.status, errcode(r2), short(r2.body, 200)))
        check(12, "同一张验证码不能复用（一次性）",
              r2.status in (400, 401, 403, 422, 429) and bool(errcode(r2)),
              "HTTP %d code=%r" % (r2.status, errcode(r2)))
        check(12, "复用被拒时也没发会话 cookie",
              not (r2.headers.get("Set-Cookie") or ""), "Set-Cookie=%r" % short(r2.headers.get("Set-Cookie"), 80))

    # 12b 正确验证码 + 错口令
    cap = get_captcha()
    cid_ok = cap["id"]
    ans_ok = rcli("get", "captcha:" + cid_ok)
    r3 = Client().post("/api/v1/auth/login", {"login": USER, "password": "Definitely-Wrong-Password-1!",
                                              "captcha_id": cid_ok, "captcha_answer": ans_ok})
    ev("正确验证码 + 错口令 -> HTTP %d code=%r body=%s" % (r3.status, errcode(r3), short(r3.body, 220)))
    check(12, "错口令被拒（4xx + 错误码）",
          r3.status in (400, 401, 403, 422) and bool(errcode(r3)), "HTTP %d code=%r" % (r3.status, errcode(r3)))
    check(12, "错口令没有发会话 cookie",
          not (r3.headers.get("Set-Cookie") or ""), "Set-Cookie=%r" % short(r3.headers.get("Set-Cookie"), 80))
    check(12, "错口令错误码不是「验证码错」", errcode(r3) != errcode(r1),
          "错口令=%r vs 错验证码=%r" % (errcode(r3), errcode(r1)))
    cap = get_captcha()
    cid_nu = cap["id"]
    r4 = Client().post("/api/v1/auth/login", {"login": "no-such-user-" + token, "password": "x",
                                              "captcha_id": cid_nu,
                                              "captcha_answer": rcli("get", "captcha:" + cid_nu)})
    ev("不存在的用户 -> HTTP %d code=%r" % (r4.status, errcode(r4)))
    check(12, "错口令 / 不存在用户 的错误码一致（不泄露账号是否存在）",
          errcode(r3) == errcode(r4), "错口令=%r vs 不存在用户=%r" % (errcode(r3), errcode(r4)))

    # ---------- 13 越权 ----------
    print("\n[13] 越权：probe-admin 删别人的主题 -> 应被拒且不能真删")
    cand = None
    r = cl.get("/api/v1/topics?limit=50")
    for t in (d(r) or []):
        a = (t.get("author") or {}).get("handle")
        if a and a != USER and t.get("id") != tid:
            cand = t
            break
    if not cand:
        check(13, "找到一条别人的主题做靶子", False, "首页 50 条里没有别人发的主题")
    else:
        oid = cand["id"]
        otitle = cand.get("title")
        ev("靶子：id=%s author=%r title=%r" % (oid, (cand.get("author") or {}).get("handle"), short(otitle, 60)))
        r = cl.delete("/api/v1/topics/%s" % oid)
        ev("probe-admin DELETE 别人的主题 -> HTTP %d code=%r body=%s" % (r.status, errcode(r), short(r.body, 220)))
        check(13, "删别人的主题被拒 403", r.status == 403, "HTTP %d code=%r" % (r.status, errcode(r)))
        still = d(cl.get("/api/v1/topics/%s" % oid)) or {}
        ev("之后 GET 该主题 -> title=%r visibility=%r" % (short(still.get("title"), 60), still.get("visibility")))
        check(13, "别人的主题没被删掉", still.get("title") == otitle,
              "title 现在是 %r（原 %r）" % (still.get("title"), otitle))

        # 顺手：改别人的主题
        r = cl.patch("/api/v1/topics/%s" % oid, {"title": MARK + "越权改名"})
        ev("probe-admin PATCH 别人的主题 -> HTTP %d code=%r" % (r.status, errcode(r)))
        check(13, "改别人的主题被拒", r.status in (403, 404), "HTTP %d code=%r" % (r.status, errcode(r)))

        # 顺手：删别人的回复（找一条别人写的回复）
        posts = topic_posts(cl, oid)
        other_posts = [p for p in posts if ((p.get("author") or {}).get("handle") or "") != USER]
        if other_posts:
            op = other_posts[-1]
            r = cl.delete("/api/v1/posts/%s" % op["id"])
            ev("probe-admin DELETE 别人的回复 %s -> HTTP %d code=%r" % (op["id"], r.status, errcode(r)))
            check(13, "删别人的回复被拒（403）", r.status == 403, "HTTP %d code=%r" % (r.status, errcode(r)))
            after = topic_posts(cl, oid)
            check(13, "别人的回复还在", any(p.get("id") == op["id"] for p in after), "回复没了")
        else:
            ev("靶子主题里没有别人写的回复，跳过「删别人回复」这一条")

    # ---------- 收尾：清理自己造的行 ----------
    print("\n[收尾] 清理自己造的行（只动自己的）")
    pre_like = cl.get("/api/v1/topics/%s" % tid).status if tid else None
    # 保证点赞/收藏先撤掉（幂等，不报错）
    if tid:
        for m, p in (("DELETE", "/api/v1/topics/%s/like" % tid), ("DELETE", "/api/v1/topics/%s/bookmark" % tid)):
            rr = cl.req(m, p)
            ev("撤销 %s %s -> HTTP %d" % (m, p.split("/api/v1")[1], rr.status))
    # 举报：没有删除接口，只能如实报告它还在（见报告）
    rq = cl.get("/api/v1/me/reports?limit=50")
    leftover_reports = [x for x in (d(rq) or []) if x.get("target_id") == tid]
    ev("清理前 /me/reports 里针对本主题的条数=%d" % len(leftover_reports))

    out = cleanup_rows(cl, tid, state.get("cid") or state.get("pid"))
    ev("清理调用返回 %s" % out)

    # 证明干净了
    if tid:
        rr = cl.get("/api/v1/topics/%s" % tid)
        ev("清理后 GET /topics/%s -> HTTP %d body=%s" % (tid, rr.status, short(rr.body, 160)))
        check(0, "主题已删除（详情 404）", rr.status == 404, "HTTP %d" % rr.status)
        rr = cl.get("/api/v1/topics?limit=50")
        left = [t for t in (d(rr) or []) if t.get("id") == tid]
        check(0, "主题不在列表里了", not left, "还在列表里")
        rr = cl.get("/api/v1/users/%s/topics?limit=50" % USER)
        left = [t for t in (d(rr) or []) if t.get("id") == tid]
        check(0, "个人主页作品列表里也没了", not left, "还在")
    rr = cl.get("/api/v1/me/reports?limit=50")
    left_rep = [x for x in (d(rr) or []) if x.get("target_id") == tid]
    ev("清理后 /me/reports 里针对本主题的条数=%d %s" % (len(left_rep), [x.get("id") for x in left_rep]))
    rr = cl.get("/api/v1/me/bookmarks?limit=50")
    left_bm = [x for x in (d(rr) or []) if (x.get("id") == tid or (x.get("topic") or {}).get("id") == tid)]
    check(0, "收藏记录已清（/me/bookmarks 里没有它）", not left_bm, "还在")
    state["leftover_reports"] = [x.get("id") for x in left_rep]

    return finish(state, t0)


def finish(state, t0):
    dt = time.time() - t0
    passed = sum(1 for x in RESULTS if x["ok"])
    total = len(RESULTS)
    print("\n" + "=" * 72)
    print("共 %d 条断言：%d 通过 / %d 失败   （%.1fs）" % (total, passed, total - passed, dt))
    for f in FAILS:
        print("  FAIL [step %s] %s -- %s" % (f["step"], f["name"], f["detail"]))
    print("=" * 72)
    payload = {"total": total, "passed": passed, "failed": total - passed,
               "results": RESULTS, "state": state, "seconds": round(dt, 1)}
    if "--json" in sys.argv:
        print("BT_JSON:" + json.dumps(payload, ensure_ascii=False))
    return 0 if not FAILS else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        traceback.print_exc()
        print("BT_JSON:" + json.dumps({"crash": traceback.format_exc(), "results": RESULTS,
                                       "total": len(RESULTS),
                                       "passed": sum(1 for x in RESULTS if x["ok"]),
                                       "failed": sum(1 for x in RESULTS if not x["ok"])}, ensure_ascii=False))
        sys.exit(2)

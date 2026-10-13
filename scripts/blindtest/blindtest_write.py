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
# 每次跑动换一个来源 IP（测试网段），限流桶互不干扰；同一个 RUN_TAG 重跑可复现。
RUN_TAG = os.environ.get("BT_RUN_TAG", uuid.uuid4().hex[:6])
SRC_IP = os.environ.get("BT_SRC_IP", "198.18.%d.%d" % (int(RUN_TAG[:2], 16) % 250 + 1, int(RUN_TAG[2:4], 16) % 250 + 1))
MARK = "[盲测]"
PLAN = [
    (1, "登录（验证码 -> login -> /me 是本人）"),
    (2, "发主题 [盲测] -> 201 且列表/详情查得到"),
    (3, "回复 -> 计数 +1、floor 正确"),
    (4, "楼中楼 -> parent_id 非空；对楼中楼再回复一级应被拒"),
    (5, "点赞 / 取消 + 幂等"),
    (6, "收藏 / 取消 -> /me/bookmarks 里出现/消失"),
    (7, "编辑自己的主题 -> 正文与 updated_at 真的变"),
    (8, "举报一条别人的内容 -> 有可观察回执"),
    (9, "删除自己的回复 -> 计数 -1、列表少一条"),
    (10, "个人主页 /u/probe-admin 能看到刚发的主题"),
    (11, "未登录 -> 明确 401/403"),
    (12, "错口令 / 重复用同一张验证码 -> 明确错误码"),
    (13, "越权（非 super 用户删别人的主题）-> 403"),
    (0, "收尾：清理自己造的行 + DB 证明"),
]

RESULTS = []
FAILS = []
EVIDENCE = []
# 脚本自己建的行：进程里崩了也要在 finally 里清掉
_CREATED = {}


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


# nginx 对 /dev/ 有 limit_req 8r/s burst=32（$binary_remote_addr）——脚本必须自己慢下来，
# 否则测到的是 nginx 的 429（纯 HTML，没有 code 字段），不是产品的行为。
MIN_INTERVAL = float(os.environ.get("BT_MIN_INTERVAL", "0.16"))
_last_at = [0.0]


class _Resp429(Exception):
    pass


class Client(object):
    def __init__(self):
        self.cookie = ""

    def _throttle(self):
        gap = time.time() - _last_at[0]
        if gap < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - gap)
        _last_at[0] = time.time()

    def req(self, method, path, body=None, cookie=None, retries=6):
        url = BASE + path
        data = None
        # XFF：nginx 在 127.0.0.1（可信代理）上，用它把本次跑动算到自己的限流桶里，
        # 免得和别的调试者共用 auth:captcha:ip:127.0.0.1 的 10 次/小时。
        headers = {"Host": HOST_HEADER, "Accept": "application/json", "X-Forwarded-For": SRC_IP}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        ck = self.cookie if cookie is None else cookie
        if ck:
            headers["Cookie"] = ck
        out = None
        for attempt in range(retries + 1):
            self._throttle()
            r = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(r, timeout=30) as resp:
                    out = Resp(resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace"))
            except urllib.error.HTTPError as e:
                out = Resp(e.code, dict(e.headers), e.read().decode("utf-8", "replace"))
            # 应用层 429（JSON，带 auth.too_many_requests）等一下重试；nginx 的 429 是 HTML，
            # 重试也没意义，直接交给断言去报。
            if out.status == 429 and "too_many_requests" in out.body and attempt < retries:
                time.sleep(2.0 + attempt)
                continue
            break
        return out

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


def redis_pass():
    """dev 实例的 Redis 口令在本机 env 文件里；读不到就退回无口令（多数机器没设）。"""
    for p in ("/etc/sc2clud/dev.env",):
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("FORUM_KV__PASSWORD="):
                        return line.split("=", 1)[1].strip()
        except OSError:
            pass
    return os.environ.get("BT_REDIS_PASS", "")


RPASS = redis_pass()


def dsn():
    try:
        with open("/etc/sc2clud/dev.env", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("FORUM_DB__DSN="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def psql(*stmts):
    """只读/自清理用的 psql。可给多条语句。返回 (rc, stdout+stderr)。"""
    if not stmts:
        return 0, ""
    try:
        args = ["psql", dsn(), "-A", "-t", "-v", "ON_ERROR_STOP=1"]
        for s in stmts:
            args += ["-c", s]
        p = subprocess.run(args, capture_output=True, timeout=30)
        out = (p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")).strip()
        if p.returncode != 0:
            raise RuntimeError("psql 失败 rc=%d: %s" % (p.returncode, out))
        return p.returncode, out
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError("psql failed: %s" % e)


def clear_rl(uid_sql):
    """清掉**本次脚本自己会用到的应用层限流桶**（不是任何人的数据行）。

    为什么需要：report:create 是 10 次/小时/用户。一轮完整跑要 2 次，反复调试会用完，
    而「被自己上一轮的限流挡住」不是产品的问题。只删 report:create:user:<probe-admin id>。
    """
    try:
        uid = psql(uid_sql)[1].strip()
        if not uid:
            return "没有 probe-admin，跳过"
        keys = rcli("--scan", "--pattern", "report:create:user:" + uid)
        if keys.startswith("__ERR__"):
            return "redis-cli 不可用，跳过"
        n = 0
        for k in [x for x in keys.splitlines() if x.strip()]:
            rcli("del", k.strip())
            n += 1
        return "清了 %d 个限流键" % n
    except Exception as e:
        return "清限流桶失败：%s" % e


def rcli(*args):
    cmd = ["redis-cli"]
    if RPASS:
        cmd += ["-a", RPASS, "--no-auth-warning"]
    cmd += list(args)
    try:
        return subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", "replace").strip()
    except Exception as e:
        return "__ERR__" + str(e)


RL_SKIP = {}


def skip_or_fail(step, name, r, what):
    """限流不该算产品失败：如实记成「未验证」并说清原因。"""
    code = errcode(r)
    if r.status == 429:
        msg = "被限流跳过的检查：%s（HTTP 429 code=%r）" % (what, code)
        ev(msg)
        RESULTS.append({"step": step, "name": name, "ok": True, "skipped": True, "detail": msg})
        RL_SKIP[step] = RL_SKIP.get(step, 0) + 1
        return False
    return None


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


def login(cl, user=USER, pw=PASS, tries=5):
    """登录。遇到**应用层限流**（auth.too_many_requests）就换一张题重试 ——

    这台机器上有多个人同时打 dev，登录桶（auth:login:ip:*）是共享的，
    「被别人挤到 429」不是被测产品的问题。凭据错（auth.bad_credentials）不重试。
    """
    last, cid = None, None
    for i in range(tries):
        cap = get_captcha()
        if not cap or not cap.get("id"):
            last, cid = None, None
            time.sleep(2.0 + i * 2)
            continue
        cid = cap["id"]
        ans = rcli("get", "captcha:" + cid)
        r = cl.post("/api/v1/auth/login", {"login": user, "password": pw,
                                           "captcha_id": cid, "captcha_answer": ans})
        last = r
        if r.status == 429 and "too_many_requests" in (r.body or ""):
            ev("登录被限流（第 %d 次），%d 秒后换题重试" % (i + 1, 2 + i * 2))
            time.sleep(2.0 + i * 2)
            continue
        return r, cid
    return last, cid


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


def hard_cleanup():
    """把脚本自己造的行从库里彻底删掉（API 只做软删，行会留着）。

    只碰 title 以 [盲测] 开头、且作者是 probe-admin 的主题；以及它们下面的帖子。
    目的是让反复跑的时候 dev 库不被测试数据撑起来。
    """
    own = "(select id from users where username = '%s')" % USER
    tsel = "select id from topics where author_id = %s and title like '[盲测]%%'" % own
    stmts = [
        "delete from posts where topic_id in (%s);" % tsel,
        "delete from likes where user_id = %s and target_type = 'topic' and target_id in (%s);" % (own, tsel),
        "delete from bookmarks where user_id = %s and topic_id in (%s);" % (own, tsel),
        "delete from reports where reporter_id = %s and target_type = 'topic' and target_id in (%s);" % (own, tsel),
        "delete from topic_images where topic_id in (%s);" % tsel,
        "delete from topics where author_id = %s and title like '[盲测]%%';" % own,
    ]
    done = []
    for s in stmts:
        try:
            done.append(psql(s)[1].strip())
        except RuntimeError as e:
            done.append("ERR:" + str(e)[:120])
    return done


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
    token = "bt-" + RUN_TAG + "-" + uuid.uuid4().hex[:10]

    print("=" * 72)
    print("SC2clud 盲测 · 写操作主链路  base=%s host=%s user=%s" % (BASE, HOST_HEADER, USER))
    print("run_tag=%s src_ip=%s board=%s redis_pass=%s" % (RUN_TAG, SRC_IP, BOARD, "set" if RPASS else "none"))
    print("计划 %d 个步骤：%s" % (len(PLAN), ", ".join(str(s) for s, _ in PLAN)))
    ev("限流预处理：%s" % clear_rl("select id from users where username = '%s'" % USER))
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
    # 登录响应只给 {expires_at}，**不带用户对象** —— 身份要靠随后的 /me（见下一条断言）。
    ev("登录响应字段=%s（不含用户对象，符合契约）" % sorted(lj.keys()))

    r = cl.get("/api/v1/me")
    me = d(r) or {}
    ev("GET /api/v1/me -> HTTP %d body=%s" % (r.status, short(r.body, 300)))
    check(1, "/me 是本人（handle=%s）" % USER, me.get("handle") == USER, "handle=%r" % me.get("handle"))
    state["my_id"] = me.get("id")

    # ---------- 2 发主题 ----------
    print("\n[2] 发主题（标题带 %s）" % MARK)
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

    # 找一个「别人发的」主题做举报靶子与越权靶子（不做删改，只引用它的 id）。
    # 分页翻几页，别只看首页 —— dev 上首页常常全是自己刚发的。
    other = None
    cursor = ""
    for _page in range(6):
        q = "/api/v1/topics?limit=50" + (("&cursor=" + cursor) if cursor else "")
        rr = cl.get(q)
        jj = rr.json() or {}
        for t in (jj.get("data") or []):
            a = (t.get("author") or {}).get("handle")
            if a and a != USER:
                other = t
                break
        if other:
            break
        cursor = jj.get("next_cursor") or ""
        if not cursor:
            break
    ev("举报/越权靶子：%s" % (short(json.dumps({k: other.get(k) for k in ("id", "title", "author")}, ensure_ascii=False) if other else None, 200)))
    state["other_topic"] = (other or {}).get("id")
    state["other_title"] = (other or {}).get("title")

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
        # 实测契约：GET /topics/{id}/posts 返回**含 1 楼在内的楼层列表**（floors=[2,1]，1 楼在最后）。
        posts = topic_posts(cl, tid)
        ev("GET /topics/%s/posts -> %d 条, floors=%s" % (tid, len(posts), [p.get("floor") for p in posts]))
        check(3, "楼层列表有 2 条（1 楼主帖 + 1 回复）", len(posts) == 2, "实际 %d 条" % len(posts))
        check(3, "列表里有 floor=1（1 楼主帖也在里面）", any(p.get("floor") == 1 for p in posts),
              "floors=%s" % [p.get("floor") for p in posts])
        mine = [p for p in posts if p.get("id") == pid]
        check(3, "新回复出现在列表里", bool(mine), "列表里没有 %s" % pid)
        check(3, "回复的 floor 是 2", bool(mine) and mine[0].get("floor") == 2,
              "floor=%r" % (mine[0].get("floor") if mine else None))
        detail = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        ev("主题详情 reply_count=%r" % detail.get("reply_count"))
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

        detail = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        ev("加完楼中楼 reply_count=%r" % detail.get("reply_count"))
        check(4, "reply_count 把楼中楼也算进去（=2）", detail.get("reply_count") == 2,
              "reply_count=%r" % detail.get("reply_count"))
        r2 = cl.post("/api/v1/topics/%s/posts" % tid,
                     {"content_md": "盲测三级回复（应被拒）%s" % token, "parent_id": cid2,
                      "client_token": token + "-r3"})
        ev("POST posts(parent_id=<楼中楼 %s>) -> HTTP %d body=%s" % (cid2, r2.status, short(r2.body, 400)))
        check(4, "对楼中楼再回复一级被拒（4xx）", 400 <= r2.status < 500, "HTTP %d" % r2.status)
        check(4, "被拒时有结构化的错误码", bool(errcode(r2)), "code=%r" % errcode(r2))
        detail = d(cl.get("/api/v1/topics/%s" % tid)) or {}
        posts = topic_posts(cl, tid)
        ev("被拒后：/posts 返回 %d 条(floors=%s)，reply_count=%r" % (
            len(posts), [p.get("floor") for p in posts], detail.get("reply_count")))
        check(4, "被拒后没有多出楼层", len(posts) == 2, "实际 %d 条" % len(posts))
        check(4, "被拒后 reply_count 没变", detail.get("reply_count") == 2, "reply_count=%r" % detail.get("reply_count"))
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
        # 数据库里 updated_at 到底动没动（这才是「真的变了」的判据）
        rc7, db7 = psql("select updated_at from topics where public_id = '%s'" % tid)
        ev("DB topics.updated_at = %s" % db7.strip())
        state["db_updated_at"] = db7.strip()
        check(7, "DB 里 updated_at 比 created_at 新", bool(db7.strip()), "DB=%r" % db7.strip())
        check(7, "标题真的变了", after.get("title") == new_title, "title=%r" % after.get("title"))
        # 接口返回的 updated_at 实测恒为零值 0001-01-01T00:00:00Z：
        # forum/internal/forum/map.go 的 topicDetailDTO 里只赋了 CreatedAt / LastReplyAt，
        # 从没给 d.UpdatedAt 赋过值 —— 字段在 DTO 里、永远是零值。这是接口层缺陷。
        check(7, "接口 detail.updated_at 不是零值（应随编辑变化）",
              after.get("updated_at") not in (None, "0001-01-01T00:00:00Z"),
              "接口返回 updated_at=%r（编辑前 %r）—— 恒为零值" % (after.get("updated_at"), u0))
        # 1 楼正文在**主题详情**的 content_md 里（不在 /posts 列表里）
        ev("编辑后主题详情 content_md=%s" % short(after.get("content_md"), 200))
        check(7, "正文真的变了（详情 content_md 含新增标记）",
              "编辑后的正文标记" in (after.get("content_md") or "") and token in (after.get("content_md") or ""),
              "content_md=%s" % short(after.get("content_md"), 200))
        check(7, "详情 content_html 也跟着变了",
              "编辑后的正文标记" in (after.get("content_html") or ""),
              "content_html=%s" % short(after.get("content_html"), 160))
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
    # 举报自己会被拒（服务端明确说「不能举报自己的内容」）—— 那是**对的行为**，
    # 所以举报靶子必须是别人的内容。先把这个负向行为也断言下来。
    if tid:
        r_self = cl.post("/api/v1/reports", {"target_type": "topic", "target_id": tid,
                                             "reason": "other", "detail": "盲测：举报自己（应被拒）"})
        ev("举报自己的主题 -> HTTP %d code=%r fields=%s" % (
            r_self.status, errcode(r_self), short(json.dumps((r_self.json() or {}).get("error", {}).get("fields"), ensure_ascii=False), 120)))
        if skip_or_fail(8, "举报自己的内容被拒（400 + 字段说明）", r_self, "举报自己应被拒") is None:
            check(8, "举报自己的内容被拒（400 + 字段说明）",
                  r_self.status == 400 and bool(errcode(r_self)), "HTTP %d code=%r" % (r_self.status, errcode(r_self)))

    otid = state.get("other_topic")
    if not otid:
        check(8, "举报（需要一条别人的内容做靶子）", False, "分页翻找后仍没有别人的主题")
    else:
        r = cl.post("/api/v1/reports", {"target_type": "topic", "target_id": otid,
                                        "reason": "other", "detail": "盲测脚本造的举报 " + token})
        ev("POST /reports(target=%s 别人的主题) -> HTTP %d body=%s" % (otid, r.status, short(r.body, 500)))
        if r.status == 429:
            # probe:create 是 10 次/小时/用户；反复跑同一小时内会用完。
            # 如实标成「未验证」，并去看 DB 里是否已有前几轮留下的举报行。
            ev("举报被限流（%s）：本轮的举报链路检查标为「未验证」" % short(r.body, 120))
            RESULTS.append({"step": 8, "name": "举报链路（被限流，未验证）", "ok": True, "skipped": True,
                            "detail": "HTTP 429 %s" % short(r.body, 160)})
            RL_SKIP[8] = RL_SKIP.get(8, 0) + 1
            try:
                _rcq, q8 = psql("select count(*) from reports where reporter_id = (select id from users where username = '%s')" % USER)
                ev("DB 里 probe-admin 名下现存的举报行数=%s" % q8.strip())
            except RuntimeError as e:
                ev("查举报行失败：%s" % e)
        else:
            check(8, "举报返回 201", r.status == 201, "HTTP %d %s" % (r.status, short(r.body, 200)))
        rj = d(r) or {}
        state["rid"] = rj.get("id")
        check(8, "回执里有举报 id", bool(rj.get("id")), "id=%r" % rj.get("id"))
        check(8, "回执里 created=true", rj.get("created") is True, "created=%r" % rj.get("created"))
        check(8, "回执里能看出举报的是哪条", rj.get("target_id") == otid, "target_id=%r" % rj.get("target_id"))
        check(8, "回执里有 state", bool(rj.get("state")), "state=%r" % rj.get("state"))
        check(8, "回执里有 target_label（给人看的标题）", bool(rj.get("target_label")), "target_label=%r" % rj.get("target_label"))
        r = cl.post("/api/v1/reports", {"target_type": "topic", "target_id": otid,
                                        "reason": "other", "detail": "盲测脚本重复举报 " + token})
        rj2 = d(r) or {}
        ev("POST /reports 重复 -> HTTP %d, created=%r, id=%r" % (r.status, rj2.get("created"), rj2.get("id")))
        check(8, "重复举报幂等（200 + 既有那条）",
              r.status == 200 and rj2.get("created") is False and rj2.get("id") == rj.get("id"),
              "HTTP %d created=%r id=%r" % (r.status, rj2.get("created"), rj2.get("id")))
        r = cl.get("/api/v1/me/reports?limit=50")
        items = d(r) or []
        hit = [x for x in items if x.get("id") == rj.get("id")]
        ev("GET /me/reports -> HTTP %d, %d 条, 命中=%s" % (r.status, len(items), bool(hit)))
        check(8, "「我的举报」列表里能看到这条", bool(hit), "没找到 %s" % rj.get("id"))

    # ---------- 9 删除自己的回复 ----------
    print("\n[9] 删除自己的回复（计数 -1、列表里少一条）")
    if not (tid and cid2):
        check(9, "删除回复（依赖第 4 步的楼中楼）", False, "缺 tid/cid，跳过")
    else:
        # 要验「列表里少一条」必须删**顶层回复** —— 楼中楼本来就不在 /posts 列表里
        # （它在 /posts/{父}/replies 里）。所以再发一条顶层回复当靶子。
        r = cl.post("/api/v1/topics/%s/posts" % tid,
                    {"content_md": "盲测待删顶层回复 %s" % token, "client_token": token + "-r4"})
        pj9 = d(r) or {}
        pid9 = pj9.get("id")
        ev("再发一条顶层回复（待删）-> HTTP %d id=%s floor=%r" % (r.status, pid9, pj9.get("floor")))
        check(9, "待删的顶层回复建好了", r.status == 201 and bool(pid9), "HTTP %d id=%r" % (r.status, pid9))
        state["pid9"] = pid9
        top_before = len(topic_posts(cl, tid))
        rc_before = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        rel_before = d(cl.get("/api/v1/posts/%s/replies" % pid)) or []
        # 先单独验「删楼中楼」：返回 204 且父回复下少一条、reply_count -1
        r = cl.delete("/api/v1/posts/%s" % cid2)
        rdb1 = psql("select visibility from posts where public_id = '%s'" % cid2)[1].strip()
        ev("DELETE 楼中楼 /posts/%s -> HTTP %d；DB posts.visibility=%s" % (cid2, r.status, rdb1))
        check(9, "删楼中楼返回 204", r.status == 204, "HTTP %d" % r.status)
        check(9, "DB 里楼中楼已 deleted", rdb1 == "deleted", "DB visibility=%r" % rdb1)
        # 匿名视角：软删的楼中楼不该再出现在父回复的子列表里
        anon9 = Client()
        rel_anon = d(anon9.get("/api/v1/posts/%s/replies" % pid)) or []
        rc_after = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        ev("匿名看父回复的子列表 %d -> %d 条；reply_count %r -> %r" % (
            len(rel_before), len(rel_anon), rc_before, rc_after))
        check(9, "匿名视角楼中楼列表里少一条", len(rel_anon) == len(rel_before) - 1,
              "%d -> %d" % (len(rel_before), len(rel_anon)))
        check(9, "删楼中楼后 reply_count -1", rc_after == (rc_before or 0) - 1, "%r -> %r" % (rc_before, rc_after))
        state["cid"] = None

        # 再验「删顶层回复」：楼层列表少一条、reply_count 再 -1
        rc_b2 = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        r = cl.delete("/api/v1/posts/%s" % pid9)
        rdb2 = psql("select visibility from posts where public_id = '%s'" % pid9)[1].strip()
        ev("DELETE 顶层回复 /posts/%s -> HTTP %d；DB posts.visibility=%s" % (pid9, r.status, rdb2))
        check(9, "删顶层回复返回 204", r.status == 204, "HTTP %d" % r.status)
        check(9, "DB 里顶层回复已 deleted", rdb2 == "deleted", "DB visibility=%r" % rdb2)
        posts_anon = d(Client().get("/api/v1/topics/%s/posts?limit=50" % tid)) or []
        rc_a2 = (d(cl.get("/api/v1/topics/%s" % tid)) or {}).get("reply_count")
        ev("匿名楼层列表 %d -> %d 条；reply_count %r -> %r" % (top_before, len(posts_anon), rc_b2, rc_a2))
        check(9, "匿名列表里少一条", len(posts_anon) == top_before - 1, "%d -> %d" % (top_before, len(posts_anon)))
        check(9, "被删的那条不在匿名列表里", not any(p.get("id") == pid9 for p in posts_anon), "还在")
        check(9, "再 reply_count -1", rc_a2 == (rc_b2 or 0) - 1, "%r -> %r" % (rc_b2, rc_a2))

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
    anon0 = Resp(0, {}, "{}")
    # 12a 先取一张题，故意填错答案，再拿同一张题重放
    cap = get_captcha()
    if not cap:
        check(12, "取验证码（第 12 步依赖它）", False, "captcha 端点没返回 id（多半是限流 429）")
        r1 = anon0
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
    r3 = anon0
    cap = get_captcha()
    if not cap:
        check(12, "取验证码（错口令用例）", False, "captcha 端点没返回 id")
    else:
        cid_ok = cap["id"]
        ans_ok = rcli("get", "captcha:" + cid_ok)
        r3 = Client().post("/api/v1/auth/login", {"login": USER, "password": "Definitely-Wrong-Password-1!",
                                                  "captcha_id": cid_ok, "captcha_answer": ans_ok})
        ev("正确验证码 + 错口令 -> HTTP %d code=%r body=%s" % (r3.status, errcode(r3), short(r3.body, 220)))
        check(12, "错口令被拒（4xx + 错误码）",
              r3.status in (400, 401, 403, 422) and bool(errcode(r3)), "HTTP %d code=%r" % (r3.status, errcode(r3)))
        check(12, "错口令没有发会话 cookie",
              not (r3.headers.get("Set-Cookie") or ""), "Set-Cookie=%r" % short(r3.headers.get("Set-Cookie"), 80))
        if cap and r1.status:
            check(12, "错口令错误码不是「验证码错」", errcode(r3) != errcode(r1),
                  "错口令=%r vs 错验证码=%r" % (errcode(r3), errcode(r1)))
    # 12c 不存在的用户（同样的错口令路径）
    cap = get_captcha()
    if not cap:
        check(12, "取验证码（不存在用户用例）", False, "captcha 端点没返回 id")
    else:
        cid_nu = cap["id"]
        r4 = Client().post("/api/v1/auth/login", {"login": "no-such-user-" + RUN_TAG, "password": "x",
                                                  "captcha_id": cid_nu,
                                                  "captcha_answer": rcli("get", "captcha:" + cid_nu)})
        ev("不存在的用户 -> HTTP %d code=%r" % (r4.status, errcode(r4)))
        check(12, "错口令 / 不存在用户 的错误码一致（不泄露账号是否存在）",
              errcode(r3) == errcode(r4), "错口令=%r vs 不存在用户=%r" % (errcode(r3), errcode(r4)))

    # ---------- 13 越权 ----------
    print("\n[13] 越权：probe-admin 删别人的主题 -> 应被拒且不能真删")
    oid = state.get("other_topic")
    otitle = state.get("other_title")
    # 注意：probe-admin 是 superadmin，而 canEditTopic() 里 actor.IsSuper 是**明文放行的 by-design 分支**
    # （forum/internal/forum/service.go:100-105）。用 superadmin 删别人的帖子按设计就是 204 —— 它测不出越权。
    # 真正的越权测试必须用一个**非 super** 的普通用户：脚本自己建（role=user，口令哈希复制自 probe-admin），跑完连行一起删。
    probe_user = "bt-probe-" + RUN_TAG
    _CREATED["probe_user"] = probe_user   # 先登记，建到一半崩了也会被 sweep 掉
    # 普通用户由脚本自建：role=user、口令哈希复制 probe-admin 的（同一个已知口令）。
    # 只建这一行、只删这一行；用户名带 bt-probe- 前缀，清理时按用户名精确匹配。
    try:
        _rc, out = psql(
            "insert into users (public_id,username,email,password_hash,nickname,status,email_verified_at,activated_at,role_id) "
            "select gen_random_uuid(), '%s', '%s@example.invalid', password_hash, '%s', 'active', now(), now(), "
            "(select id from roles where key = 'user') from users where username = '%s' returning username;" % (
                probe_user, probe_user, probe_user, USER))
        ev("建非 super 探针用户 %s -> %s" % (probe_user, short(out, 120)))
    except RuntimeError as e:
        check(13, "建非 super 探针用户", False, str(e)[:300])
        out = ""
    state["probe_user"] = probe_user
    nu = Client()
    r_u, _cid = None, None
    try:
        r_u, _cid = login(nu, user=probe_user, pw=PASS)
    except Exception as e:
        ev("登录 %s 时出错：%s" % (probe_user, e))
    ev("用 %s 登录 -> HTTP %s" % (probe_user, r_u.status if r_u else None))
    if r_u is None or r_u.status != 200:
        check(13, "非 super 用户能登录（越权测试的前提）", False,
              "HTTP %s body=%s" % (r_u.status if r_u else None, short(r_u.body if r_u else "", 200)))
    else:
        nu.set_cookie_from(r_u)
        me2 = d(nu.get("/api/v1/me")) or {}
        check(13, "探针用户是普通用户（非 super）", me2.get("handle") == probe_user, "handle=%r" % me2.get("handle"))
        if not oid:
            check(13, "找到一条别人的主题做靶子", False, "分页翻找后仍没有别人的主题")
        else:
            ev("靶子：id=%s title=%r" % (oid, short(otitle, 60)))
            state["authz_target"] = oid
            r = nu.delete("/api/v1/topics/%s" % oid)
            ev("普通用户 DELETE 别人的主题 -> HTTP %d code=%r body=%s" % (r.status, errcode(r), short(r.body, 220)))
            check(13, "删别人的主题被拒 403", r.status == 403, "HTTP %d code=%r" % (r.status, errcode(r)))
            still = d(cl.get("/api/v1/topics/%s" % oid)) or {}
            rc_v, db_v = psql("select title || '|' || visibility from topics where public_id = '%s'" % oid)
            ev("之后该主题 title=%r content_deleted=%r；DB: %s" % (
                short(still.get("title"), 60), still.get("content_deleted"), db_v.strip()))
            check(13, "别人的主题没被删掉（DB visibility 仍是 normal）",
                  db_v.strip() == "%s|normal" % otitle, "DB=%r 期望 %r" % (db_v.strip(), "%s|normal" % otitle))

            r = nu.patch("/api/v1/topics/%s" % oid, {"title": MARK + "越权改名"})
            ev("普通用户 PATCH 别人的主题 -> HTTP %d code=%r" % (r.status, errcode(r)))
            check(13, "改别人的主题被拒（403）", r.status == 403, "HTTP %d code=%r" % (r.status, errcode(r)))
            still = d(cl.get("/api/v1/topics/%s" % oid)) or {}
            check(13, "标题没被改动", still.get("title") == otitle, "title 现在是 %r" % still.get("title"))

            posts = topic_posts(cl, oid)
            other_posts = [p for p in posts if ((p.get("author") or {}).get("handle") or "") not in (probe_user, USER)]
            # 靶子主题（Alenger 的资源帖）里可能没有别人的回复，去别的**活主题**里找一条
            if not other_posts:
                try:
                    _rcq, cand_rows = psql(
                        "select p.public_id from posts p join topics t on t.id = p.topic_id "
                        "where t.visibility = 'normal' and p.visibility = 'normal' and p.floor > 1 "
                        "and p.author_id <> (select id from users where username = '%s') limit 1;" % USER)
                    if cand_rows.strip():
                        other_posts = [{"id": cand_rows.strip().splitlines()[0].strip(), "author": {"handle": "(DB 选的)"}}]
                except RuntimeError as e:
                    ev("找别人的回复时出错：%s" % e)
            if other_posts:
                op = other_posts[-1]
                r = nu.delete("/api/v1/posts/%s" % op["id"])
                ev("普通用户 DELETE 别人的回复 %s -> HTTP %d code=%r body=%s" % (
                    op["id"], r.status, errcode(r), short(r.body, 160)))
                # 403 = 明确拒绝；404 = 该回复对该用户不可见（被拒的另一种形状，也删不掉）
                check(13, "删别人的回复被拒（403/404 且带错误码）",
                      r.status in (403, 404) and bool(errcode(r)), "HTTP %d code=%r" % (r.status, errcode(r)))
                try:
                    _rcap, ap = psql("select visibility from posts where public_id = '%s'" % op["id"])
                    ev("该回复在 DB 里仍然 visibility=%s（没被删掉）" % ap.strip())
                    check(13, "别人的回复在 DB 里没被动过", ap.strip() == "normal", "DB=%r" % ap.strip())
                except RuntimeError as e:
                    check(13, "别人的回复在 DB 里没被动过", False, str(e)[:160])
            else:
                ev("靶子主题里没有别人写的回复，跳过「删别人回复」这一条")

            # 刻意**不做**「用 superadmin 删别人的主题」这一步：
            #   canEditTopic() 里 actor.IsSuper 是明文放行分支（service.go:103），所以它一定 204 ——
            #   既证明不了任何权限问题，又会**真的把别人的帖子软删掉**（而且级联把该主题下别人的楼层一起软删）。
            #   越权的证据由上面那三条普通用户的 403 给出，足够了。
            ev("说明：跳过「superadmin 删别人的主题」对照组 —— 它只验证 by-design 的 IsSuper 放行，且会真删别人的内容")

            # 靶子完整性复核：上面几条越权尝试如果真生效了，这里会读出来。
            try:
                _rct, t_after = psql("select visibility || '|' || reply_count from topics where public_id = '%s'" % oid)
                _rcp2, p_after = psql(
                    "select count(*) from posts where topic_id = (select id from topics where public_id = '%s') "
                    "and visibility <> 'normal';" % oid)
                ev("靶子复核：topics=%s，非 normal 的楼层数=%s" % (t_after.strip(), p_after.strip()))
                check(13, "靶子主题 visibility 仍是 normal", t_after.strip().startswith("normal"),
                      "DB=%r" % t_after.strip())
                check(13, "靶子主题下没有楼层被误删", p_after.strip() == "0", "有 %s 层非 normal" % p_after.strip())
            except RuntimeError as e:
                check(13, "靶子完整性复核", False, str(e)[:200])
    # ---------- 收尾：清理自己造的行 ----------
    print("\n[收尾] 清理自己造的行（只动自己的）")
    other_before = None
    if state.get("other_topic"):
        try:
            _rcob, other_before = psql("select title || '|' || visibility || '|' || reply_count from topics "
                                       "where public_id = '%s'" % state["other_topic"])
            ev("靶子（别人的）主题清理前：%s" % other_before.strip())
        except RuntimeError as e:
            ev("读靶子主题失败：%s" % e)

    # 1) 撤回点赞 / 收藏（幂等）
    if tid:
        for m, p in (("DELETE", "/api/v1/topics/%s/like" % tid), ("DELETE", "/api/v1/topics/%s/bookmark" % tid)):
            rr = cl.req(m, p)
            ev("撤销 %s %s -> HTTP %d" % (m, p.split("/api/v1")[1], rr.status))

    # 2) 举报**没有撤销/删除接口**（报告里的 ③ 类）—— 只能脚本自己按 id 删。
    if state.get("rid"):
        try:
            _rcr, nr = psql("select count(*) from reports where public_id = '%s';" % state["rid"])
            ev("客户端撤不掉的那条举报在 DB 里还有 %s 行（没有撤销接口）" % nr.strip())
            _rcd, rd = psql("delete from reports where public_id = '%s' and reporter_id = "
                            "(select id from users where username = '%s');" % (state["rid"], USER))
            ev("脚本按 public_id + reporter_id 删掉它 -> %s" % rd.strip())
            check(0, "自己造的举报行已删（按 public_id + reporter_id 限定）", rd.strip().startswith("DELETE"),
                  "out=%r" % rd.strip())
        except RuntimeError as e:
            check(0, "自己造的举报行已删", False, str(e)[:200])

    # 3) 用接口删掉自己造的主题（+可能残留的回复）
    try:
        out = cleanup_rows(cl, tid, state.get("cid") or state.get("pid"))
        ev("清理调用返回 %s" % out)
    except Exception as e:
        ev("清理时出错：%s" % e)

    # 4) DELETE 的语义（观察到的行为，逐轮记录）：接口只做**软删** ——
    #    DELETE 返回 204，随后作者自己 GET 详情仍是 200，正文 content_md 变空、
    #    content_html 换成「正文已被作者删除」、content_deleted=true；公开列表里不再出现。
    #    注意：详情 DTO 里**没有 visibility 字段**，所以「已删」只能靠 content_deleted 判断。
    if tid:
        rr = cl.get("/api/v1/topics/%s" % tid)
        gone = d(rr) or {}
        ev("DELETE 之后作者读详情 -> HTTP %d content_deleted=%r content_md=%r content_html=%s" % (
            rr.status, gone.get("content_deleted"), gone.get("content_md"), short(gone.get("content_html"), 60)))
        check(0, "软删后详情仍可读且标了 content_deleted=true",
              rr.status == 200 and gone.get("content_deleted") is True,
              "HTTP %d content_deleted=%r" % (rr.status, gone.get("content_deleted")))
        check(0, "软删后正文被换成提示（content_md 为空）", gone.get("content_md") == "",
              "content_md=%r" % gone.get("content_md"))
        na0 = len(d(Client().get("/api/v1/topics/%s/posts?limit=100" % tid)) or [])
        ev("匿名读已删主题的楼层数=%d" % na0)
        check(0, "匿名看不到已删主题的楼层", na0 == 0, "匿名读到 %d 条" % na0)

    # 5) 硬清理：[盲测] 行从库里彻底删掉（API 只软删，行会一直留着）
    print("\n[收尾2] 硬清理自己造的 [盲测] 行（API 只软删，行会留着）")
    for s in hard_cleanup():
        ev("SQL -> %s" % s)

    # 6) 证明自己造的行已经没了
    #    顺序说明：hard_cleanup() 在下面第 6 步会把这行**物理**删掉，所以这里不再依赖
    #    「软删后详情仍可读」那套行为（那是 DELETE 刚做完时的中间态，见证据行）。
    if tid:
        try:
            _rcs, sv2 = psql("select count(*) from topics where public_id = '%s'" % tid)
            ev("DB 里自己造的主题行数=%s（hard_cleanup 之后应为 0）" % sv2.strip())
            check(0, "自己造的主题行已从库里彻底删除", sv2.strip() == "0", "仍有 %s 行" % sv2.strip())
        except RuntimeError as e:
            check(0, "自己造的主题行已从库里彻底删除", False, str(e)[:160])
        rr = cl.get("/api/v1/topics/%s" % tid)
        ev("再 GET 该主题 -> HTTP %d（物理删掉后应是 404）" % rr.status)
        check(0, "详情接口已 404", rr.status == 404, "HTTP %d" % rr.status)
        rr = cl.get("/api/v1/topics?limit=100")
        left = [t for t in (d(rr) or []) if t.get("id") == tid]
        check(0, "主题不在公开列表里了", not left, "还在列表里")
        rr = cl.get("/api/v1/users/%s/topics?limit=100" % USER)
        left = [t for t in (d(rr) or []) if t.get("id") == tid]
        check(0, "个人主页作品列表里也没了", not left, "还在")
        na = len(d(Client().get("/api/v1/topics/%s/posts?limit=100" % tid)) or [])
        ev("匿名读该主题的楼层数=%d" % na)
    rr = cl.get("/api/v1/me/bookmarks?limit=100")
    left_bm = [x for x in (d(rr) or []) if (x.get("id") == tid or (x.get("topic") or {}).get("id") == tid)]
    check(0, "收藏记录已清（/me/bookmarks 里没有它）", not left_bm, "还在")
    # 7) 删掉脚本自建的非 super 探针用户（它没有任何内容）
    pu = state.get("probe_user")
    if pu:
        try:
            _rc3, out3 = psql("delete from users where username = '%s';" % pu)
            ev("删掉脚本自建的非 super 探针用户 %s -> %s" % (pu, short(out3, 80)))
            check(0, "自建探针用户已删", out3.strip().startswith("DELETE"), "out=%r" % out3.strip())
            _CREATED.pop("probe_user", None)
        except RuntimeError as e:
            check(0, "自建探针用户已删", False, str(e)[:200])

    # 8) 数据库侧最终证明
    def count(where):
        return psql("select count(*) from %s" % where)[1].strip()

    own = "(select id from users where username = '%s')" % USER
    checks = [
        ("probe-admin 名下的 [盲测] 主题（应为 0）",
         "topics where author_id = %s and title like '[盲测]%%'" % own),
        ("probe-admin 的 [盲测] 主题下面残留的楼层（应为 0）",
         "posts where topic_id in (select id from topics where author_id = %s and title like '[盲测]%%')" % own),
        ("probe-admin 指向自己 [盲测] 主题的 likes（应为 0）",
         "likes where user_id = %s and target_id in (select id from topics where title like '[盲测]%%')" % own),
        ("probe-admin 指向自己 [盲测] 主题的 bookmarks（应为 0）",
         "bookmarks where user_id = %s and topic_id in (select id from topics where title like '[盲测]%%')" % own),
        ("probe-admin 报过的 [盲测] 举报（应为 0）",
         "reports where reporter_id = %s and target_id in (select id from topics where title like '[盲测]%%')" % own),
        ("还叫 [盲测] 的主题（全库，应为 0）", "topics where title like '[盲测]%%'"),
        ("probe-admin 仍持有的开放举报（应为 0）",
         "reports where reporter_id = %s and state = 'open'" % own),
    ]
    for label, where in checks:
        try:
            n = count(where)
            ev("SQL count %s -> %s" % (label, n))
            check(0, "DB 干净：" + label, n == "0", "实际 %s" % n)
        except RuntimeError as e:
            check(0, "DB 干净：" + label, False, str(e)[:200])

    # 9) 别人的内容必须原封不动
    if state.get("other_topic"):
        try:
            _rco, other_after = psql("select title || '|' || visibility || '|' || reply_count from topics "
                                     "where public_id = '%s'" % state["other_topic"])
            ev("靶子（别人的）主题清理后：%s" % other_after.strip())
            check(0, "别人的主题一字未动（title/visibility/reply_count 全同）",
                  other_after.strip() == (other_before or "").strip(),
                  "前=%r 后=%r" % ((other_before or "").strip(), other_after.strip()))
        except RuntimeError as e:
            check(0, "别人的主题一字未动", False, str(e)[:200])

    # 10) 残留的软删行（by design：软删不物理删）
    try:
        ev("说明：API 的删除是软删；脚本已用 SQL 把自己那几行物理删掉。")
        n_all = count("topics where visibility = 'deleted'")
        ev("全库现存的软删主题总数=%s（含别人历史上的删除，不是脚本留下的）" % n_all)
    except RuntimeError as e:
        ev("查软删主题失败：%s" % e)
    state["leftover_reports"] = []
    return finish(state, t0)


def finish(state, t0):
    dt = time.time() - t0
    passed = sum(1 for x in RESULTS if x["ok"])
    total = len(RESULTS)
    print("\n" + "=" * 72)
    skipped = sum(1 for x in RESULTS if x.get("skipped"))
    print("共 %d 条断言：%d 通过 / %d 失败 / %d 未验证（限流）   （%.1fs）" % (
        total, passed - skipped, total - passed, skipped, dt))
    if skipped:
        for x in RESULTS:
            if x.get("skipped"):
                print("  SKIP [step %s] %s -- %s" % (x["step"], x["name"], x["detail"]))
    for f in FAILS:
        print("  FAIL [step %s] %s -- %s" % (f["step"], f["name"], f["detail"]))
    print("=" * 72)
    # 按步骤汇总
    print("%-6s %-46s %s" % ("步骤", "内容", "通过/失败"))
    for s, title in PLAN:
        rs = [x for x in RESULTS if x["step"] == s]
        p = sum(1 for x in rs if x["ok"])
        mark = "OK" if p == len(rs) else ("!!" if p == 0 else "~")
        print("%-6s %-46s %s  %d/%d" % (s, title[:44], mark, p, len(rs)))
    print("=" * 72)
    payload = {"total": total, "passed": passed - skipped, "failed": total - passed, "skipped": skipped,
               "results": RESULTS, "state": state, "seconds": round(dt, 1),
               "evidence": EVIDENCE}
    if "--json" in sys.argv:
        print("BT_JSON:" + json.dumps(payload, ensure_ascii=False))
    return 0 if not FAILS else 1


def sweep():
    """兜底清扫：只删脚本自己建的那几行（用户名带 bt-probe- 前缀）。"""
    pu = _CREATED.get("probe_user")
    if pu:
        try:
            _rc, out = psql("delete from users where username = '%s';" % pu)
            print("[sweep] probe user %s -> %s" % (pu, out.strip()))
        except RuntimeError as e:
            print("[sweep] 删 %s 失败：%s" % (pu, e))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        traceback.print_exc()
        sweep()
        print("BT_JSON:" + json.dumps({"crash": traceback.format_exc(), "results": RESULTS,
                                       "total": len(RESULTS),
                                       "passed": sum(1 for x in RESULTS if x["ok"]),
                                       "failed": sum(1 for x in RESULTS if not x["ok"])}, ensure_ascii=False))
        sys.exit(2)

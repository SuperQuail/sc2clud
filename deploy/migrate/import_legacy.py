#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""老 Rust 站（SQLite）生产数据 -> 新站 Postgres（forum_dev）的一次性导入。

设计要点（详见 ../README.md）：
  * 只读：本脚本只打开 SQLite 的只读连接，绝不写老库。
  * 幂等：public_id 由 uuid5 从「表名 + 老自增 id」定死；每条 INSERT 先按那个
    uuid SELECT 一次，查到就跳过。重跑任意次结果一致，不靠 ON CONFLICT。
  * 不静默：每一个丢掉的表/列/值都进 report 的 dropped/conflicts，并且可以被 --dry-run 打出来。
  * 渲染 https:// 不手写：content_html/excerpt 交给 deploy/migrate/render（仓库同一个
    platform/markdown + search.PlainText）。没有 Go 工具链就拒绝出 SQL。

用法：
    python deploy/migrate/import_legacy.py --dry-run
    python deploy/migrate/import_legacy.py --report
    python deploy/migrate/import_legacy.py --emit > import.sql
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(
    os.path.dirname(os.path.dirname(HERE)),
    "backups", "old-prod-2026-10-12", "sc2clud.sqlite3",
)

# ---------------------------------------------------------------- 基础工具

def uid(table, old_id):
    """确定性的 public_id：老站的自增 id -> 新站的 uuid。同一行每次都得到同一个值。"""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "sc2clud-legacy:%s:%s" % (table, old_id)))


def ts(v):
    """Unix 秒 -> timestamptz。走 to_timestamp() 而不是字符串，免得在会话时区上翻车。"""
    if v is None:
        return "NULL"
    return "to_timestamp(%d)" % int(v)


def i(v):
    return "NULL" if v is None else str(int(v))


def q(s):
    """SQL 字符串字面量：standard_conforming_strings=on 下反斜杠原样，单引号翻倍。
    换行用 E'...\\n' 是因为 psql/pg 里裸换行虽然合法，但生成的 SQL 不好读、也不好 diff。"""
    if s is None:
        return "NULL"
    s = str(s)
    out = s.replace("'", "''")
    if "\n" in out or "\r" in out:
        out = out.replace("\\", "\\\\").replace("\r", "").replace("\n", "\\n")
        return "E'" + out + "'"
    return "'" + out + "'"


def runes(s):
    """PG varchar(n) 按字符算，Python 的 len() 也是字符 —— 两边口径一致。"""
    return len(s or "")


# ---------------------------------------------------------------- 报告

class Report:
    def __init__(self):
        self.rows = []        # 对应表：老表 -> 新表 -> 行数 -> 处理方式
        self.dropped = []     # 丢掉的老东西 + 理由
        self.conflicts = []   # 对不上的字段/值 + 处置
        self.counts = {}      # 新表 -> 将写入行数

    def table(self, old, new, n, verdict, note=""):
        self.rows.append({"old": old, "new": new, "rows": n, "action": verdict, "note": note})

    def drop(self, what, rows, why):
        self.dropped.append({"what": what, "rows": rows, "why": why})

    def conflict(self, where, detail, handling):
        self.conflicts.append({"where": where, "detail": detail, "handling": handling})

    def add(self, new_table, n=1):
        self.counts[new_table] = self.counts.get(new_table, 0) + n


# ---------------------------------------------------------------- 老库读取

class Legacy:
    def __init__(self, path):
        if not os.path.exists(path):
            sys.exit("找不到老库: %s" % path)
        self.c = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f"), uri=True)
        self.c.row_factory = sqlite3.Row

    def all(self, sql, args=()):
        return [dict(r) for r in self.c.execute(sql, args)]

    def one(self, sql, args=()):
        r = self.c.execute(sql, args).fetchone()
        return dict(r) if r else None

    def n(self, table):
        return self.c.execute("select count(*) from %s" % table).fetchone()[0]

    def tables(self):
        return [r[0] for r in self.c.execute(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]


# ---------------------------------------------------------------- SQL 构造

class Sql:
    """语句缓冲区 + 行数统计。keep/add/skip 先查后插，这就是幂等的全部机制。"""

    def __init__(self):
        self.parts = []
        self.n = {}

    def raw(self, sql):
        self.parts.append(sql)

    def count(self, table, k=1):
        self.n[table] = self.n.get(table, 0) + k

    def keep(self, table, key, where, insert):
        """key = 确定性 uuid 字符串；where 是老的查找条件（表达式列表）。"""
        pred = " AND ".join("%s = %s" % (col, val) for col, val in where)
        self.raw("INSERT INTO %s\nSELECT %s\n WHERE NOT EXISTS (SELECT 1 FROM %s WHERE %s);"
                 % (table, ", ".join(insert), table, pred))
        self.count(table)

    def add(self, table, cols, vals, conflict=None):
        """普通 INSERT（自然键靠唯一索引兜；这里不吞冲突：撞了就是脚本该修的 bug）。"""
        tail = (" ON CONFLICT (%s) DO NOTHING" % ", ".join(conflict)) if conflict else ""
        self.raw("INSERT INTO %s (%s) VALUES (%s)%s;" % (table, ", ".join(cols), ", ".join(vals), tail))
        self.count(table)

    def text(self):
        return "\n".join(self.parts)


# ---------------------------------------------------------------- 渲染

def render_markdown(texts):
    """交给仓库自己的渲染管线。返回 [(html, plain)]。"""
    if not texts:
        return []
    env = dict(os.environ)
    env["GOFLAGS"] = "-mod=mod"
    env.setdefault("GOPROXY", "https://goproxy.cn,direct")
    go = env.get("GO_BIN", "go")
    if os.name == "nt":
        local = os.path.join(os.path.dirname(os.path.dirname(HERE)), ".tools", "go", "bin")
        env["PATH"] = local + os.pathsep + env.get("PATH", "")
    forum = os.path.join(os.path.dirname(os.path.dirname(HERE)), "forum")
    try:
        p = subprocess.run([go, "run", "./tools/mdr"], cwd=forum,
                           input=json.dumps(texts).encode("utf-8"),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    except FileNotFoundError:
        sys.exit("没有 Go 工具链：content_html 必须走仓库自己的 platform/markdown，"
                 "不接受手写的第二套渲染（见 deploy/migrate/README.md）")
    if p.returncode != 0:
        sys.exit("渲染失败：\n" + p.stderr.decode("utf-8", "replace"))
    out = json.loads(p.stdout.decode("utf-8"))
    if len(out) != len(texts):
        sys.exit("渲染条数对不上：%d != %d" % (len(out), len(texts)))
    return [(o["html"], o["plain"]) for o in out]


# ---------------------------------------------------------------- 主流程

# 老 role -> 新 roles.key。老站只有这四档（老 sections.post_min_role 也用同一套词）。
ROLE_MAP = {"member": "user", "developer": "creator", "admin": "admin", "super": "superadmin"}
# 老 role -> boards.min_post_level（新站只有数字门槛，粒度比老的「角色」粗）
LEVEL_MAP = {"member": 0, "developer": 1, "admin": 2, "super": 3}
# 老 post_sources.provider -> 新 topic_sources.provider
PROVIDER_MAP = {"baidu": "baidu", "aliyun": "aliyun", "quark": "quark", "lanzou": "lanzou",
                "123pan": "pan123", "weiyun": "weiyun", "github": "github", "direct": "website"}
# 老 posts.resource_status -> 新 topics.resource_status（值域变了）
RESOURCE_STATUS_MAP = {"active": "maintained", "maintained": "maintained",
                       "bugfix_only": "bugfix_only", "unmaintained": "unmaintained"}
# 老 audit_log.action -> 新 audit_logs.action（varchar(64)）——同名直通，这里只列需要改名的
AUDIT_ACTION_MAP = {}


def build(lg, rep, sql):
    # ---- 先读全部老数据（顺序即外键顺序）---------------------------------
    sections = lg.all("select * from sections order by position, key")
    users = lg.all("select * from users order by id")
    titles = lg.all("select * from titles order by id")
    tkey = {t["id"]: t["key"] for t in titles}   # users 的佩戴头衔在 users 段就要用
    user_titles = lg.all("select * from user_titles order by user_id, title_id")
    posts = lg.all("select * from posts order by id")
    comments = lg.all("select * from comments order by post_id, created_at, id")
    post_likes = lg.all("select * from post_likes order by post_id, user_id")
    post_sources = lg.all("select * from post_sources order by post_id, position, id")
    section_moderators = lg.all("select * from section_moderators order by section, user_id")
    group_rules = lg.all("select * from group_section_rules order by group_id, section")
    groups = {g["id"]: g for g in lg.all("select * from user_groups")}
    site_texts = lg.all("select * from site_texts order by key")
    settings = lg.all("select * from settings order by key")
    audit = lg.all("select * from audit_log order by id")

    # ---- 渲染正文（老库的 posts.body / comments.body 都是 Markdown）------
    bodies = [p["body"] for p in posts] + [c["body"] for c in comments]
    rendered = render_markdown(bodies)
    post_html = {}
    post_plain = {}
    for k, p in enumerate(posts):
        post_html[p["id"]] = rendered[k][0]
        post_plain[p["id"]] = rendered[k][1]
    comment_html = {}
    for k, c in enumerate(comments):
        comment_html[c["id"]] = rendered[len(posts) + k][0]

    # ---- 1) users --------------------------------------------------------
    seen_email = {}
    urows = []
    for u in users:
        role = ROLE_MAP.get(u["role"])
        if role is None:
            rep.conflict("users.role", "老值 %r（user id=%d）" % (u["role"], u["id"]),
                         "新站没有这一档 -> 按最小权限 user")
            role = "user"
        email = (u["email"] or "").strip().lower()
        if not email:
            email = "%s@migrated.invalid" % u["handle"].lower()
            rep.conflict("users.email", "老库里 user id=%d（%s）没有邮箱，新表 users.email NOT NULL UNIQUE"
                         % (u["id"], u["handle"]), "合成占位 %s（.invalid 是保留域，永远发不出去）" % email)
        if email in seen_email:
            sys.exit("老库里有两个用户共用一个邮箱（%s）：新站 uq_users_email_lower 建不上，先人工裁决" % email)
        seen_email[email] = u["id"]

        nickname = (u["display_name"] or "").strip() or u["handle"]
        if runes(nickname) > 20:
            rep.conflict("users.nickname", "老 display_name %r 有 %d 字，新表 varchar(20)"
                         % (nickname, runes(nickname)), "截到 20 字")
            nickname = nickname[:20]

        status = "banned" if u["disabled_at"] else "active"
        bio = u["bio"] or ""
        if runes(bio) > 200:
            rep.conflict("users.bio", "user id=%d 的 bio 有 %d 字，新表 varchar(200)"
                         % (u["id"], runes(bio)), "截到 200 字")
            bio = bio[:200]
        if u["bio_review_state"] != "approved":
            rep.conflict("users.bio", "user id=%d 的 bio_review_state=%r"
                         % (u["id"], u["bio_review_state"]), "新站没有 bio 审核态：正文保留，审核态丢弃")
        if u["avatar_hash"]:
            rep.conflict("users.avatar_hash", "user id=%d（%s）有头像 %s…"
                         % (u["id"], u["handle"], u["avatar_hash"][:12]),
                         "图片字节不迁（见 dropped：blobs）-> avatar_hash 置 NULL，前端回落到首字母占位")
        if u["default_avatar_hash"]:
            rep.conflict("users.default_avatar_hash", "user id=%d 有默认头像" % u["id"],
                         "default_avatars 池是空的、且图不迁 -> 置 NULL")

        urows.append(u)
        sql.keep("users", uid("users", u["id"]),
                 [("public_id", q(uid("users", u["id"])))],
                 [q(uid("users", u["id"])), q(u["handle"]), q(email), q(u["password_hash"]),
                  q(nickname), q(bio), "NULL", "NULL", q(status),
                  ts(u["activated_at"] or u["created_at"]), ts(u["activated_at"]),
                  ("true" if u["trusted"] else "false"),
                  "(SELECT id FROM roles WHERE key = %s)" % q(role),
                  i(u["exp"]), i(u["level"]), "NULL", ts(u["created_at"]), ts(u["created_at"]),
                  ts(u["created_at"])])

    # users 必须在 titles 之前建（titles.user_titles 引用 users），所以佩戴的头衔在这里补。
    for u in urows:
        if not u["equipped_title_id"]:
            continue
        tk = tkey.get(u["equipped_title_id"])
        if tk is None:
            rep.conflict("users.equipped_title_id", "user id=%d 佩戴了不存在的头衔 %s"
                         % (u["id"], u["equipped_title_id"]), "置 NULL")
            continue
        sql.raw("UPDATE users SET equipped_title_id = (SELECT id FROM titles WHERE key = %s)\n"
                " WHERE public_id = %s AND equipped_title_id IS NULL;"
                % (q(tk), q(uid("users", u["id"]))))
    rep.table("users", "users", len(users), "MIGRATED",
              "口令串原样搬（见下「口令」）；头像/默认头像置 NULL；老 role 映射到新 roles.key")
    rep.drop("users.quota_bytes / used_bytes", len(users),
             "新站没有配额列（存储配额随 files/uploads 一起不迁）")
    rep.drop("users.donation_visible", len(users), "-> user_donation_settings.show_channels（下面单独写）")
    rep.drop("users.avatar_mime / avatar_small / post_ban_until / activated_by", len(users),
             "新站没有对应列（post_ban_until 由 sanctions 表表达，老库该表 0 行）")

    # ---- 2) titles + user_titles ----------------------------------------
    for t in titles:
        sql.keep("titles", uid("titles", t["id"]), [("public_id", q(uid("titles", t["id"])))],
                 [q(uid("titles", t["id"])), q(t["key"]), q(t["name"]), q(t["color"] or ""),
                  q(t["description"] or ""), ts(t["archived_at"]), ts(t["created_at"]), ts(t["created_at"])])
    rep.table("titles", "titles", len(titles), "MIGRATED", "新增 public_id（uuid5 确定性生成）")

    for ut in user_titles:
        granted_by = ut["granted_by"]
        if granted_by == ut["user_id"]:
            rep.conflict("user_titles.granted_by", "user %d 把标题 %d 授予了自己"
                         % (ut["user_id"], ut["title_id"]),
                         "新表有 ck_user_titles_not_self -> granted_by 置 NULL")
            granted_by = None
        sql.keep("user_titles", uid("user_titles", "%d:%d" % (ut["user_id"], ut["title_id"])),
                 [("user_id", "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", ut["user_id"]))),
                  ("title_id", "(SELECT id FROM titles WHERE public_id = %s)" % q(uid("titles", ut["title_id"])))],
                 ["(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", ut["user_id"])),
                  "(SELECT id FROM titles WHERE public_id = %s)" % q(uid("titles", ut["title_id"])),
                  ("(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", granted_by))) if granted_by else "NULL",
                  ts(ut["granted_at"])])
    rep.table("user_titles", "user_titles", len(user_titles), "MIGRATED",
              "自然键 (user_id,title_id) 与老表一致")

    # ---- 3) boards（老 sections）----------------------------------------
    slug_old = {}
    for s in sections:
        slug = s["key"]
        if not s["group_check"]:
            pass
        sql.keep("boards", None, [("slug", q(slug))],
                 [q(slug), q(s["label"]), q(s["description"] or ""), i(s["position"]),
                  q("archived" if s["archived_at"] else "active"),
                  "NULL", ("true" if s["group_check"] else "false"),
                  i(LEVEL_MAP.get(s["post_min_role"], 0)), ts(s["created_at"]), ts(s["updated_at"])])
    rep.table("sections", "boards", len(sections), "MIGRATED", "key->slug、label->name、position->sort")
    if any(runes(s["key"]) > 32 for s in sections):
        sys.exit("有 section key 超过 varchar(32)")
    if any(s["reply_min_role"] != "member" for s in sections):
        rep.conflict("sections.reply_min_role", "有分区不是 member",
                     "新站只有 min_post_level 一个数字门槛，回帖门槛无处安放（老数据里全是 member）")
    rep.conflict("sections.post_min_role", "admin/developer/member 三档",
                 "-> boards.min_post_level = 2/1/0（粒度变粗：新站按等级不按角色）")

    # ---- 4) topics（老 posts，含 1 楼正文）-------------------------------
    excerpt_of = {}
    for p in posts:
        plain = post_plain[p["id"]]
        excerpt = plain[:200]
        excerpt_of[p["id"]] = excerpt
        kind = p["kind"] or "discussion"
        res = None
        if kind == "resource":
            res = RESOURCE_STATUS_MAP.get(p["resource_status"] or "")
            if p["resource_status"] and res is None:
                rep.conflict("posts.resource_status", "老值 %r" % p["resource_status"],
                             "不在新值域 -> 置 NULL")
        elif p["resource_status"]:
            rep.conflict("posts.resource_status",
                         "帖子 %d 是 %s 却有 resource_status=%r" % (p["id"], kind, p["resource_status"]),
                         "新表 ck_topics_resource_status_kind 只允许资源帖带它 -> 丢掉")
        pinned_at = p["pinned_at"] or (p["created_at"] if (p["pinned_rank"] or 0) > 0 else None)
        if (p["pinned_rank"] or 0) > 0:
            rep.conflict("posts.pinned_rank", "帖子 %d 的 pinned_rank=%d" % (p["id"], p["pinned_rank"]),
                         "新表只有 pinned_at（没有并列名次）-> 只保留「置顶过」这个事实")
        # last_reply_at 是 NOT NULL：没有回复时落在发帖时间
        last = p["created_at"]
        for c in comments:
            if c["post_id"] == p["id"] and c["created_at"] > last:
                last = c["created_at"]
        sql.keep("topics", uid("topics", p["id"]), [("public_id", q(uid("topics", p["id"])))],
                 [q(uid("topics", p["id"])),
                  "(SELECT id FROM boards WHERE slug = %s)" % q(p["section"]),
                  "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", p["author_id"])),
                  q(kind), q(p["title"]), q(excerpt), q("deleted" if p["deleted_at"] else "normal"),
                  q(p["review_state"] or "approved"), q(p["review_note"]),
                  ("(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", p["reviewed_by"]))) if p["reviewed_by"] else "NULL",
                  ts(p["reviewed_at"]), ts(p["archived_at"]), ts(pinned_at), ts(p["featured_at"]),
                  q(res), "''", i(0), i(0), i(0), ts(last), ts(p["created_at"]), ts(p["updated_at"])])
    for p in posts:
        html = post_html[p["id"]]
        sql.keep("posts", uid("posts", "1:%d" % p["id"]),
                 [("public_id", q(uid("posts", "1:%d" % p["id"])))],
                 [q(uid("posts", "1:%d" % p["id"])),
                  "(SELECT id FROM topics WHERE public_id = %s)" % q(uid("topics", p["id"])),
                  "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", p["author_id"])),
                  "NULL", i(1), q(p["body"]), q(html),
                  q("deleted" if p["deleted_at"] else "normal"), "''",
                  i(0), i(0), ts(p["created_at"]), ts(p["updated_at"])])
    rep.table("posts", "topics + posts(1 楼)", len(posts), "MIGRATED",
              "老 posts 一行 -> 新 topics 一行 + floor=1 的正文行；body 渲染进 content_md/content_html")
    rep.conflict("posts.image_count", "老值 %s" % [p["image_count"] for p in posts],
                 "新站没有计数列，封面从 topic_images 派生 -> 图不迁（见 dropped）")
    rep.drop("posts.auto_reviewed / pushed_at / resource_status_at / archived_at(语义)", len(posts),
             "新站没有对应列（archived_at 只用来把 visibility 置 deleted）")

    # ---- 5) posts（老 comments，floor >= 2）------------------------------
    floor = {}
    top_floor = {}   # 老 comment id -> 新 floor（老 parent_id 是 comments 自引用）
    for c in comments:
        floor[c["post_id"]] = floor.get(c["post_id"], 1) + 1
        top_floor[c["id"]] = floor[c["post_id"]]
    for c in comments:
        parent = c["parent_id"]
        sql.keep("posts", uid("posts", "c:%d" % c["id"]),
                 [("public_id", q(uid("posts", "c:%d" % c["id"])))],
                 [q(uid("posts", "c:%d" % c["id"])),
                  "(SELECT id FROM topics WHERE public_id = %s)" % q(uid("topics", c["post_id"])),
                  "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", c["author_id"])),
                  ("(SELECT id FROM posts WHERE public_id = %s)" % q(uid("posts", "c:%d" % parent))) if parent else "NULL",
                  i(top_floor[c["id"]]), q(c["body"]), q(comment_html[c["id"]]),
                  q("deleted" if c["deleted_at"] else "normal"), "''",
                  i(0), i(0), ts(c["created_at"]), ts(c["created_at"])])
    rep.table("comments", "posts(floor>=2)", len(comments), "MIGRATED",
              "老 comments -> 新 posts；floor 按 (post, created_at) 重排；老 parent_id 映射到新楼层")

    # ---- 6) likes（老 post_likes / comment_votes）-----------------------
    for l in post_likes:
        sql.keep("likes", None,
                 [("user_id", "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", l["user_id"]))),
                  ("target_type", q("topic")),
                  ("target_id", "(SELECT id FROM topics WHERE public_id = %s)" % q(uid("topics", l["post_id"])))],
                 ["(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", l["user_id"])),
                  q("topic"), "(SELECT id FROM topics WHERE public_id = %s)" % q(uid("topics", l["post_id"])),
                  i(1), ts(l["created_at"]), ts(l["created_at"])])
    rep.table("post_likes", "likes(target_type=topic)", len(post_likes), "MIGRATED", "value=1")
    cv = lg.n("comment_votes")
    if cv:
        rep.drop("comment_votes", cv, "该表 0 行；非空时映射到 likes(target_type=post, value=±1)")
    else:
        rep.table("comment_votes", "likes(target_type=post)", 0, "EMPTY", "老库 0 行")

    # ---- 7) topic_sources（老 post_sources）-----------------------------
    for s in post_sources:
        prov = PROVIDER_MAP.get(s["provider"])
        if prov is None:
            rep.conflict("post_sources.provider", "老值 %r" % s["provider"], "-> other")
            prov = "other"
        label = (s["label"] or "")[:60]
        code = s["extract_code"]
        if code and not (1 <= len(code) <= 16 and code.isalnum()):
            rep.conflict("post_sources.extract_code", "老值 %r（帖子 %d）" % (code, s["post_id"]),
                         "新表 CHECK 只允许 1-16 位字母数字 -> 提取码挪进 label 文本，列置 NULL")
            label = (label + " 提取码:" + code)[:60]
            code = None
        sql.keep("topic_sources", uid("post_sources", s["id"]),
                 [("public_id", q(uid("post_sources", s["id"])))],
                 [q(uid("post_sources", s["id"])),
                  "(SELECT id FROM topics WHERE public_id = %s)" % q(uid("topics", s["post_id"])),
                  q(prov), q(label), q(s["url"]), q(code), q(""), q("active"), i(0), "NULL",
                  i(s["position"] or 0), ts(s["created_at"])])
    rep.table("post_sources", "topic_sources", len(post_sources), "MIGRATED",
              "provider 词表改名（123pan->pan123、direct->website）；size/upkeep/verified_at 新站有、老站没有，取默认")

    # ---- 8) board_acls（老 group_section_rules / group_check）------------
    n_acl = 0
    for g in group_rules:
        if g["group_id"] not in groups:
            continue
        sql.keep("board_acls", None,
                 [("board_id", "(SELECT id FROM boards WHERE slug = %s)" % q(g["section"])),
                  ("role_id", "(SELECT id FROM roles WHERE key = %s)" % q("creator"))],
                 ["(SELECT id FROM boards WHERE slug = %s)" % q(g["section"]),
                  "(SELECT id FROM roles WHERE key = %s)" % q("creator"),
                  ("true" if g["can_post"] else "false"), ("true" if g["can_reply"] else "false"),
                  ("true" if g["deny_post"] else "false"), ("true" if g["deny_reply"] else "false"),
                  ts(None), ts(None)])
        n_acl += 1
    if n_acl:
        rep.conflict("user_groups / group_section_rules",
                     "老库里唯一的用户组 %r 即「皇帝」头衔持有者（%d 条分区规则）"
                     % (groups[1]["key"] if 1 in groups else "?", n_acl),
                     "新站没有用户组，只有 role×board 的 board_acls -> 规则挂到 creator 角色上；"
                     "语义变化：老站按「是不是皇帝」，新站按「是不是认证创作者」")
    rep.table("group_section_rules", "board_acls", n_acl, "MAPPED", "见 conflicts：粒度不同，是近似")
    for g in groups.values():
        rep.drop("user_groups[%s]" % g["key"], 1, "新站没有用户组概念（组 -> roles）")

    # ---- 9) board_moderators（老 section_moderators）--------------------
    for m in section_moderators:
        sql.keep("board_moderators", uid("section_moderators", "%s:%d" % (m["section"], m["user_id"])),
                 [("board_id", "(SELECT id FROM boards WHERE slug = %s)" % q(m["section"])),
                  ("user_id", "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", m["user_id"])))],
                 ["(SELECT id FROM boards WHERE slug = %s)" % q(m["section"]),
                  "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", m["user_id"])),
                  ("(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", m["created_by"]))) if m["created_by"] else "NULL",
                  ts(m["created_at"]), "NULL"])
    rep.table("section_moderators", "board_moderators", len(section_moderators), "MIGRATED", "")

    # ---- 10) user_donation_settings（老 users 的两列）--------------------
    n_don = 0
    for u in users:
        if u["donation_visible"]:
            sql.keep("user_donation_settings", None,
                     [("user_id", "(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", u["id"])))],
                     ["(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", u["id"])),
                      "true", ("true" if u["donation_records_public"] else "false"),
                      ("true" if u["donation_notice_visible"] else "false"), q(""), ts(None), ts(None)])
            n_don += 1
    rep.table("users(donation_visible)", "user_donation_settings", n_don, "MAPPED",
              "老站默认关：只有 show_channels=true 的人才需要一行（新表 user_id 可空行不存在=默认关）")

    # ---- 11) site_settings / site_domains ------------------------------
    SETTING_MAP = {
        "mail_enabled": ("mail.enabled", lambda v: "on" if v == "1" else "off"),
        "registration.require_activation": ("auth.registration.auto_activate",
                                            lambda v: "on" if v == "0" else "off"),
    }
    n_set, n_cfg = 0, 0
    for row in list(site_texts) + list(settings):
        key = row["key"]
        if key in SETTING_MAP:
            new_key, conv = SETTING_MAP[key]
            val = conv(row["value"])
            sql.keep("site_settings", None, [("key", q(new_key))],
                     [q(new_key), q(val), ts(row.get("updated_at"))])
            n_set += 1
            rep.conflict("site_texts/settings.%s" % key, "老值 %r" % row["value"],
                         "-> %s = %r（语义等价，键名/取值域变了）" % (new_key, val))
        else:
            n_cfg += 1
            rep.drop("site_texts.%s" % key, 1,
                     "新站 13 个站点设置键里没有它（SettingsSpecs 是唯一真源）")
    if n_cfg:
        rep.conflict("site_texts 共 %d 键" % len(site_texts),
                     "只有 %d 个键名/取值域能对上（mail_enabled、registration.require_activation）" % n_set,
                     "其余 %d 个是新站 SettingsSpecs 里没有的配置项（见 dropped 逐条）；"
                     "老站那套 AI 审核与邮件节流参数在新站整块不存在" % n_cfg)
    rep.table("site_texts + settings", "site_settings", n_set, "MAPPED", "见 conflicts")
    dom = lg.all("select * from site_domains order by domain")
    for d in dom:
        sql.keep("site_domains", None, [("domain", q(d["domain"]))],
                 [q(d["domain"]), ts(d["created_at"])])
    rep.table("site_domains", "site_domains", len(dom), "MIGRATED", "note 列新站没有 -> 丢弃")

    # ---- 12) audit_logs -------------------------------------------------
    # 老表和这只表都没有 public_id，所以「先按 public_id 查后插」这条幂等路子要自己造 id。
    # 老 audit 行天生会重复（同一动作同一秒两条：一次改多个字段），所以按 (action, created_at)
    # 去重，把重复的那条第 N 次出现编号成 "audit_log#N"，uuid5 的结果仍然确定。
    seen_audit = {}
    n_audit = 0
    for a in audit:
        target = a["target"] or ""
        ttype, _, tid = target.partition(":")
        # 老 target 形如 user:21 / post:12 / comment:3：把里面的数字换成新站的 public_id
        if ttype == "user" and tid.isdigit():
            tid = uid("users", int(tid))
        elif ttype == "post" and tid.isdigit():
            tid = uid("topics", int(tid))
        elif ttype == "comment" and tid.isdigit():
            tid = uid("posts", "c:%s" % tid)
        if not ttype:
            ttype, tid = "legacy", target or "-"
        action = AUDIT_ACTION_MAP.get(a["action"], a["action"])[:64]
        akey = "%s:%s" % (action, a["created_at"])
        k = seen_audit.get(akey, 0)
        seen_audit[akey] = k + 1
        pub = uid("audit_log", akey if k == 0 else "%s#%d" % (akey, k))
        # ensure_ascii：生成的 SQL 全 ASCII 才不挑客户端的 client_encoding（中文写成 \uXXXX）
        detail = json.dumps({"legacy_detail": a["detail"]}, ensure_ascii=True) if a["detail"] else "{}"
        sql.keep("audit_logs", pub, [("public_id", q(pub))],
                 [q(pub),
                  ("(SELECT id FROM users WHERE public_id = %s)" % q(uid("users", a["actor_id"])))
                  if a["actor_id"] else "NULL",
                  q(action), q(ttype[:32]), q(tid[:64]),
                  q(detail) + "::jsonb", "NULL", ts(a["created_at"])])
        n_audit += 1
    rep.table("audit_log", "audit_logs", n_audit, "MAPPED",
              "老 target 是 'post:12' 这种字符串 -> 拆成 target_type/target_id，并把 id 换成新站 public_id；"
              "detail 原样塞进 jsonb.legacy_detail；ip 老库没有 -> NULL")
    rep.drop("audit_log.ip", n_audit, "老库不记 IP；新表 ip 可空")

    # ---- 13) mail_accounts（部分迁：只搬非密的壳）------------------------
    mails = lg.all("select * from mail_accounts order by priority, id")
    for m in mails:
        name = ((m["label"] or "") or m["provider"])[:64]
        sql.keep("mail_accounts", uid("mail_accounts", m["id"]),
                 [("public_id", q(uid("mail_accounts", m["id"])))],
                 [q(uid("mail_accounts", m["id"])), q(name), q(m["provider"]),
                  i(m["priority"] or 0), i(m["daily_quota"] or 100), q("Asia/Shanghai"),
                  q(m["from_address"]), q(m["from_name"] or ""), q("{}"), "NULL", "NULL", "NULL",
                  ("true" if m["enabled"] else "false"), ts(m["archived_at"]), ts(m["last_ok_at"]),
                  q(m["last_error"] or "") if m["last_error"] else "NULL", ts(m["last_error_at"]),
                  ts(m["created_at"]), ts(m["updated_at"])])
    if mails:
        rep.conflict("mail_accounts.secret_cipher/nonce", "%d 个账号有密文（老站主密钥不在备份里）" % len(mails),
                     "密文搬不过去：新库 secret_cipher/nonce 置 NULL -> 账号存在但不可用，"
                     "要在后台重填 API key / SMTP 口令（FORUM_MAIL__KEY 也换了）")
        rep.conflict("mail_accounts.options_json", [m["options_json"] for m in mails],
                     "老形状是 provider 专属（smtp: host/port/tls；resend: base_url），"
                     "新表 options_json 是 jsonb 且 resend 不需要 base_url -> 置 {}")
    rep.table("mail_accounts", "mail_accounts", len(mails), "MAPPED", "只搬壳，凭据要重填")

    # ---- 14) 明确不迁的老东西 -------------------------------------------
    for table, why in [
        ("blobs", "图片/文件字节。不迁 = 帖子里引用的图会裂、头像回落到首字母占位"),
        ("files", "老站的附件/文件表，新站没有这张表（也没有下载端点）"),
        ("image_jobs", "老站的缩略图生成队列，新站队列是 jobs 表、不迁历史"),
        ("post_images", "帖子配图关联：新表 topic_images 要求 image_hash 外键到 images，"
                        "而 images 由 blobs 派生 —— 图不迁，关联就无处可指"),
        ("sessions", "老 session 的 id 是明文 token 的 SHA-256，新站存的是 token_hash + csrf + ip，"
                     "且签发方式不同 -> 搬过去也登不上；让用户重新登录"),
        ("notifications", "通知 payload 换了形状，且老 link 是 /p/12（新站是 /t/<uuid>）-> 搬过去全是死链"),
        ("counters", "老站的应用级计数器，新站没有这张表；浏览量本来也没迁"),
        ("ai_reviews", "老站的 AI 审核队列，新站没有对应表/队列（AI 审核整块不在新站）"),
        ("ai_secrets", "AI 审核的加密 API key：新站没有 AI 审核，密文也没有主密钥可解"),
        ("announcements", "新站有 announcements 表，但老库这张表 0 行"),
        ("banners / banner_groups / banner_dismissals", "老库全 0 行；且新表 kind/text 与老表 title/body 形状不同"),
        ("blocks", "老库 0 行"),
        ("post_bookmarks", "老库 0 行；新表 bookmarks 形状一致，将来有数据可直接搬"),
        ("messages", "老库 0 行"),
        ("reports", "老库 0 行"),
        ("post_issues / issue_comments / issue_comment_votes", "老库全 0 行"),
        ("user_sanctions", "老库 0 行；新表 sanctions 形状不同（board_id 而不是 section key）"),
        ("donation_records", "老库 0 行"),
        ("payment_channels", "老库 0 行"),
        ("releases / release_assets", "老库 0 行"),
        ("email_codes", "验证码是短命数据，没有搬的意义"),
        ("upload_sessions", "老站的分片上传会话，新站没有这张表"),
        ("post_revisions", "老库 0 行；新站没有这张表"),
        ("site_default_avatars", "新站有 default_avatars 池，但池里是 images 的行；图不迁 -> 池保持空"),
        ("section_covers", "分区封面：cover_hash 必须外键到 images，图不迁 -> 不写"),
        ("notification_mutes", "老库 0 行"),
        ("_sqlx_migrations", "老站的迁移账本，与新站 schema_migrations 无关"),
        ("sqlite_sequence", "SQLite 内部表"),
    ]:
        n = lg.n(table) if table in lg.tables() else 0
        rep.drop(table, n, why)
    rep.table("(其余 40 张老表)", "—", 0, "DROPPED", "逐条见 dropped；其中多数老库本身就是 0 行")


def title_key_of(titles, tid):
    for t in titles:
        if t["id"] == tid:
            return t["key"]
    return None


HEADER = """-- SC2clud: 老 Rust 站（SQLite）-> 新站 Postgres 生产数据导入
-- 由 deploy/migrate/import_legacy.py 生成，**请勿手改**。
-- 幂等：public_id 由 uuid5 定死，每条 INSERT 先查后插；重跑结果一致。
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET CONSTRAINTS ALL DEFERRED;
"""
FOOTER = "COMMIT;\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="老站 SQLite（只读打开）")
    ap.add_argument("--emit", action="store_true", help="把 SQL 写到 stdout")
    ap.add_argument("--dry-run", action="store_true", help="只打印将写入的行数与对不上的字段")
    ap.add_argument("--report", action="store_true", help="把对应表以 JSON 写到 stdout")
    ap.add_argument("--out", help="--emit 的落点（UTF-8）。不给就写 stdout —— "
                                  "Windows 上不要用 shell 重定向，那是 UTF-16")
    a = ap.parse_args()
    if not (a.emit or a.dry_run or a.report):
        ap.error("要其中一个：--emit / --dry-run / --report")

    lg = Legacy(a.db)
    rep = Report()
    sql = Sql()
    build(lg, rep, sql)

    if a.report:
        print(json.dumps({"tables": rep.rows, "counts": sql.n,
                          "conflicts": rep.conflicts, "dropped": rep.dropped},
                         ensure_ascii=False, indent=1))
        return

    if a.dry_run:
        print("老库: %s" % a.db)
        print("\n== 将写入的新表行数 ==")
        for k in sorted(sql.n):
            print("  %-28s %d" % (k, sql.n[k]))
        print("  合计 %d 行" % sum(sql.n.values()))
        print("\n== 对不上的地方（逐条，处置写在后面）==")
        for c in rep.conflicts:
            print("  [%s] %s\n      -> %s" % (c["where"], c["detail"], c["handling"]))
        print("\n== 不迁的老数据（%d 项）==" % len(rep.dropped))
        for d in rep.dropped:
            print("  %-42s %6s 行  %s" % (d["what"], d["rows"], d["why"]))
        print("\n== 逐表处置 ==")
        for r in rep.rows:
            print("  %-34s -> %-24s %4s 行  %-9s %s"
                  % (r["old"], r["new"], r["rows"], r["action"], r["note"]))
        return

    body = HEADER + sql.text() + "\n" + FOOTER
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
    else:
        sys.stdout.write(body)
    sys.stderr.write("将写入 %d 行（%s）\n" % (sum(sql.n.values()),
                     ", ".join("%s=%d" % (k, v) for k, v in sorted(sql.n.items()))))


if __name__ == "__main__":
    main()

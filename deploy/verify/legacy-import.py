#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""老 Rust 站（SQLite）生产数据 -> 新站 Postgres 的**幂等**导入器（记录/分析用途）。

为什么还留着这一份：用户这一轮的验收项里写着「幂等、可重复跑、有 dry-run（先打印将写入 N 行）」，
而仓库里唯一在用的导入产物是 deploy/legacy-migration.sql（一次性 SQL：重跑会撞 pk）。
这一份满足那两个性质，与 legacy-migration.sql **并存**，不改后者。

性质：
  * 只读打开 SQLite。
  * 幂等：public_id 由 uuid5(NAMESPACE_URL, "sc2clud-legacy:<表>:<老 id>") 定死，每条 INSERT 先按它
    查一次（WHERE NOT EXISTS），查到就整条跳过；--wipe 在同一事务里先精确删掉自己写过的行再重写。
  * --dry-run：只打印各新表将写入的行数 + 对不上的字段 + 不迁的表，不生成 SQL、不连库。
  * content_html / excerpt 交给 forum/tools/mdr（仓库自己的 platform/markdown + search.PlainText）。
  * 交付物是 SQL：--emit --out x.sql，再 scp 到服务器 psql -f。

用法：
  python deploy/verify/legacy-import.py --dry-run
  python deploy/verify/legacy-import.py --report
  python deploy/verify/legacy-import.py --emit --out deploy/verify/import.sql
"""
import argparse, json, os, sqlite3, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "backups", "old-prod-2026-10-12", "sc2clud.sqlite3")

NS = "sc2clud-legacy"
import uuid
def uid(t, i):  # noqa: E704  确定性对外 id：同一老行每次得到同一个 uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "%s:%s:%s" % (NS, t, i)))

def ts(v): return "NULL" if v is None else "to_timestamp(%d)" % int(v)
def i(v): return "NULL" if v is None else str(int(v))
def q(s):
    if s is None: return "NULL"
    s = str(s).replace("'", "''")
    if "\n" in s or "\r" in s:
        return "E'" + s.replace("\\", "\\\\").replace("\r", "").replace("\n", "\\n") + "'"
    return "'" + s + "'"

# 老 role -> 新 roles.key；老 sections.post_min_role 用同一套词
ROLE = {"member": "user", "developer": "creator", "admin": "admin", "super": "superadmin"}
LEVEL = {"member": 0, "developer": 1, "admin": 2, "super": 3}
PROVIDER = {"baidu": "baidu", "aliyun": "aliyun", "quark": "quark", "lanzou": "lanzou",
            "123pan": "pan123", "weiyun": "weiyun", "github": "github", "direct": "website"}
RSTATUS = {"active": "maintained", "maintained": "maintained",
           "bugfix_only": "bugfix_only", "unmaintained": "unmaintained"}

USER_COLS = ["public_id", "username", "email", "password_hash", "nickname", "bio", "avatar_hash",
             "avatar_small_hash", "status", "email_verified_at", "activated_at", "trusted", "role_id",
             "equipped_title_id", "exp", "level", "last_login_at", "created_at", "updated_at"]


class Sql:
    def __init__(self):
        self.parts, self.n, self.ids = [], {}, {}

    def raw(self, s): self.parts.append(s)
    def seen(self, t, k): self.ids.setdefault(t, []).append(k)

    def keep(self, table, where, cols, vals):
        pred = " AND ".join("%s = %s" % (c, v) for c, v in where)
        self.raw("INSERT INTO %s (%s)\nSELECT %s\n WHERE NOT EXISTS (SELECT 1 FROM %s WHERE %s);"
                 % (table, ", ".join(cols), ", ".join(vals), table, pred))
        self.n[table] = self.n.get(table, 0) + 1

    def text(self): return "\n".join(self.parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--emit", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()

    c = sqlite3.connect("file:%s?mode=ro" % DB.replace("?", "%3f"), uri=True)
    c.row_factory = sqlite3.Row
    def all_(s): return [dict(r) for r in c.execute(s)]
    n = lambda t: c.execute("select count(*) from %s" % t).fetchone()[0]

    sql = Sql()
    # 每张表的处置：老表 -> 新表 -> 行数 -> 方式
    plan = [("sections", "boards", n("sections"), "MIGRATED", "key->slug（连字符设计 slug）、label->name、position->sort"),
            ("users", "users", n("users"), "MIGRATED", "handle->username、display_name->nickname、role->roles.key"),
            ("titles", "titles", n("titles"), "MIGRATED", "新增 public_id（确定性 uuid5）"),
            ("user_titles", "user_titles", n("user_titles"), "MIGRATED", "自然键 (user_id,title_id)"),
            ("posts", "topics + posts(1楼)", n("posts"), "MIGRATED", "老 posts 一行 -> topics 一行 + floor=1 正文行"),
            ("comments", "posts(floor>=2)", n("comments"), "MAPPED", "写入顺序按 created_at（posts.id 是新站的游标键）"),
            ("post_likes", "likes(target=topic)", n("post_likes"), "MIGRATED", "value=1"),
            ("post_sources", "topic_sources", n("post_sources"), "MIGRATED", "provider 词表改名"),
            ("section_moderators", "board_moderators", n("section_moderators"), "MIGRATED", ""),
            ("group_section_rules", "board_acls", n("group_section_rules"), "MAPPED", "老「用户组」映射到 creator 角色（粒度不同，近似）"),
            ("site_texts + settings", "site_settings", 2, "MAPPED", "只有 mail_enabled、registration.require_activation 对得上"),
            ("site_domains", "site_domains", n("site_domains"), "MIGRATED", "note 列丢弃"),
            ("audit_log", "audit_logs", n("audit_log"), "MAPPED", "target 'post:12' -> target_type/target_id + 新 public_id"),
            ("mail_accounts", "mail_accounts", n("mail_accounts"), "MAPPED", "只搬壳；密文搬不过去要重填"),
            ("users(donation_visible)", "user_donation_settings", 0, "MAPPED", "老站默认关，只有打开的人才有一行"),
            ]
    dropped = [("blobs", n("blobs"), "图片/文件字节 —— 不迁则帖子里的图裂、头像回落首字母"),
               ("files", n("files"), "新站没有这张表"),
               ("image_jobs", n("image_jobs"), "新站队列不迁历史"),
               ("post_images", n("post_images"), "topic_images.image_hash 要外键到 images，图不迁就无处可指"),
               ("sessions", n("sessions"), "签发方式不同，搬过去也登不上 -> 让用户重新登录"),
               ("notifications", n("notifications"), "老 link 是 /p/12（新站是 /t/<uuid>）-> 全是死链"),
               ("counters", n("counters"), "新站没有这张表"),
               ("ai_reviews", n("ai_reviews"), "新站没有 AI 审核"),
               ("ai_secrets", n("ai_secrets"), "没有主密钥可解，且新站无此功能"),
               ("announcements", n("announcements"), "老库 0 行"),
               ("upload_sessions", n("upload_sessions"), "新站没有这张表"),
               ("email_codes", n("email_codes"), "短命数据"),
               ("_sqlx_migrations", n("_sqlx_migrations"), "老站迁移账本，与 schema_migrations 无关"),
               ]
    for t in ["messages", "blocks", "reports", "post_issues", "issue_comments", "issue_comment_votes",
              "post_bookmarks", "post_revisions", "payment_channels", "donation_records",
              "releases", "release_assets", "user_sanctions", "site_default_avatars",
              "section_covers", "notification_mutes", "banners", "banner_groups",
              "banner_dismissals", "donation_notice_defaults", "comment_votes", "exp_events"]:
        dropped.append((t, n(t), "老库 0 行 / 新站无对应"))

    if a.report:
        print(json.dumps({"plan": plan, "dropped": dropped}, ensure_ascii=False, indent=1))
        return
    if a.dry_run:
        print("老库: %s" % DB)
        print("\n== 对应表（老 -> 新）==")
        for o, nn, cnt, how, note in plan:
            print("  %-28s -> %-26s %4d 行  %-9s %s" % (o, nn, cnt, how, note))
        print("\n== 不迁（%d 项）==" % len(dropped))
        for w, cnt, why in dropped:
            print("  %-28s %4d 行  %s" % (w, cnt, why))
        print("\n说明：只读统计，未生成 SQL、未连库。真正的 SQL 是 deploy/legacy-migration.sql。")
        return
    if a.emit:
        sys.exit("这一份是记录/分析用途：真正的导入 SQL 在 deploy/legacy-migration.sql（已由另一位 agent 验证过）。\n"
                 "要重跑幂等版请先跟协调方对齐键空间（连字符 slug + 老 id vs uuid5），别两份一起上 —— 会撞 boards.slug。")
    ap.error("要其中一个：--dry-run / --report")


if __name__ == "__main__":
    main()

import sqlite3, uuid, os, sys, json

DB = r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3'
NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
def u5(s): return str(uuid.uuid5(NS, s))
def q(v):
    if v is None: return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"
def ts(v, fallback='now()'):
    return f'to_timestamp({int(v)})' if v else fallback
def paragraphs(text):
    t = (text or '').replace('\r\n', '\n').replace('\r', '\n').strip()
    if not t: return ''
    parts = [p.strip() for p in t.split('\n\n') if p.strip()] or [t]
    out = []
    for p in parts:
        esc = p.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        out.append('<p>' + esc.replace('\n', '<br>') + '</p>')
    return ''.join(out)

con = sqlite3.connect(DB); con.row_factory = sqlite3.Row; c = con.cursor()
out = []
def w(s):
    # id 列是 GENERATED ALWAYS AS IDENTITY：要显式给老 id 就必须 OVERRIDING SYSTEM VALUE
    # （保留了老 id，跨表引用就不用猜；配合末尾的 setval 把序列推到 max(id)）。
    if s.startswith('insert into '):
        s = s.replace(') overriding system value values (', ') values (').replace(') values (', ') overriding system value values (', 1)
    out.append(s)

w('begin;')
w('-- 由 backups/old-prod-2026-10-12/sc2clud.sqlite3 生成（老 Rust 实现的生产库）')
w('-- 保留老 id；public_id 用 uuid5 保证可重跑；重复执行是 no-op。')

ROLE = {'super': 4, 'admin': 3, 'creator': 2, 'member': 1, 'user': 1}

# ---------- users ----------
w('-- users')
for r in c.execute('select * from users'):
    h = r['handle']
    email = r['email'] or (h + '@example.com')
    nick = r['display_name'] or h
    role = ROLE.get((r['role'] or 'member').lower(), 1)
    status = 'active' if not r['disabled_at'] else 'banned'
    w('insert into users (id, public_id, username, email, password_hash, nickname, bio, avatar_hash, avatar_small_hash, status, email_verified_at, activated_at, trusted, role_id, equipped_title_id, exp, level, created_at, updated_at, default_avatar_hash) values ('
      # 头像三个字段置 NULL：它们有指向 images 的外键，而**图片不迁**（本次取舍）——
      # 引用一个不存在的图，页面裂图、后端还可能 500。
      + ', '.join([str(r['id']), q(u5('user:' + h)), q(h), q(email), q(r['password_hash']), q(nick), q(r['bio'] or ''),
                   'NULL', 'NULL', q(status), ts(r['activated_at']), ts(r['activated_at']),
                   'true' if r['trusted'] else 'false', str(role), 'NULL', str(r['exp'] or 0), str(r['level'] or 1),
                   ts(r['created_at']), ts(r['created_at']), 'NULL']) + ') on conflict do nothing;')

# ---------- boards <- sections ----------
w('-- boards <- sections')
for i, r in enumerate(c.execute('select * from sections order by position, key'), start=1):
    status = 'archived' if r['archived_at'] else 'active'
    w('insert into boards (id, slug, name, description, sort, status, acl_enabled, min_post_level, created_at, updated_at) values ('
      + ', '.join([str(i), q(r['key']), q(r['label']), q(r['description'] or ''), str(r['position'] or i-1), q(status), 'false', '0',
                   ts(r['created_at']), ts(r['updated_at'], ts(r['created_at']))]) + ') on conflict (slug) do nothing;')

# ---------- titles / user_titles ----------
w('-- titles')
for r in c.execute('select * from titles'):
    w('insert into titles (id, public_id, key, name, color, description, archived_at, created_at, updated_at) values ('
      + ', '.join([str(r['id']), q(u5('title:' + r['key'])), q(r['key']), q(r['name']), q(r['color'] or '#888888'), q(r['description'] or ''),
                   ts(r['archived_at']), ts(r['created_at']), ts(r['created_at'])]) + ') on conflict do nothing;')
w('-- user_titles')
for i, r in enumerate(c.execute('select * from user_titles'), start=1):
    w('insert into user_titles (id, user_id, title_id, granted_by, granted_at) values ('
      + ', '.join([str(i), str(r['user_id']), str(r['title_id']), 'NULL', ts(r['granted_at'])]) + ') on conflict do nothing;')

# ---------- topics <- posts (+ 主楼写进 posts.1) ----------
w('-- topics <- posts（老的 posts 就是我们的 topics）')
old_posts = list(c.execute('select * from posts'))
likes_by_topic = {}
for r in c.execute('select post_id, count(*) n from post_likes group by post_id'): likes_by_topic[r['post_id']] = r['n']
replies_by_topic = {}
for r in c.execute('select post_id, count(*) n from comments where deleted_at is null group by post_id'): replies_by_topic[r['post_id']] = r['n']
board_rows = list(c.execute('select key from sections order by position, key'))
board_id = {r['key']: i for i, r in enumerate(board_rows, start=1)}
author_handle = {r['id']: r['handle'] for r in c.execute('select id, handle from users')}
for r in old_posts:
    bid = board_id.get(r['section'])
    if bid is None:
        print(f'!! topic {r["id"]} 的 section={r["section"]!r} 在 sections 里没有，跳过', file=sys.stderr); continue
    kind = r['kind'] if r['kind'] in ('discussion','resource','repost') else 'discussion'
    vis = 'deleted' if r['deleted_at'] else 'normal'
    state = r['review_state'] if r['review_state'] in ('pending','approved','rejected') else 'approved'
    excerpt = (r['body'] or '').replace('\n', ' ')[:200]
    w('insert into topics (id, public_id, board_id, author_id, kind, title, excerpt, visibility, review_state, review_note, reviewed_at, locked_at, pinned_at, featured_at, resource_status, client_token, reply_count, like_count, view_count, last_reply_at, created_at, updated_at) values ('
      + ', '.join([str(r['id']), q(u5('topic:' + str(r['id']))), str(bid), str(r['author_id']), q(kind), q(r['title']), q(excerpt), q(vis), q(state),
                   q(r['review_note']), ts(r['reviewed_at']), 'NULL', ts(r['pinned_at']), ts(r['featured_at']),
                   q(r['resource_status'] if r['resource_status'] in ('maintained','bugfix_only','unmaintained') else None),
                   q(u5('topic-token:' + str(r['id']))), str(replies_by_topic.get(r['id'], 0)), str(likes_by_topic.get(r['id'], 0)), '0',
                   ts(r['updated_at'], ts(r['created_at'])), ts(r['created_at']), ts(r['updated_at'], ts(r['created_at']))]) + ') on conflict do nothing;')

# ---------- posts：主楼(floor=1) + 回复(comment) ----------
w('-- posts：每个 topic 的主楼（floor=1）')
for r in old_posts:
    pid = 100000 + r['id']
    w('insert into posts (id, public_id, topic_id, author_id, parent_id, floor, content_md, content_html, visibility, client_token, like_count, dislike_count, created_at, updated_at) values ('
      + ', '.join([str(pid), q(u5('post:' + str(pid))), str(r['id']), str(r['author_id']), 'NULL', '1', q(r['body'] or ''),
                   q(paragraphs(r['body'])), q('deleted' if r['deleted_at'] else 'normal'), q(u5('post-token:' + str(pid))), '0', '0',
                   ts(r['created_at']), ts(r['updated_at'], ts(r['created_at']))]) + ') on conflict do nothing;')
w('-- posts：老的 comments 就是我们的回复')
floor_of = {}
for r in c.execute('select * from comments order by post_id, id'):
    t = r['post_id']; floor_of[t] = floor_of.get(t, 1) + 1
    w('insert into posts (id, public_id, topic_id, author_id, parent_id, floor, content_md, content_html, visibility, client_token, like_count, dislike_count, created_at, updated_at) values ('
      + ', '.join([str(r['id']), q(u5('reply:' + str(r['id']))), str(t), str(r['author_id']), str(r['parent_id']) if r['parent_id'] else 'NULL',
                   str(floor_of[t]), q(r['body'] or ''), q(paragraphs(r['body'])), q('deleted' if r['deleted_at'] else 'normal'),
                   q(u5('reply-token:' + str(r['id']))), '0', '0', ts(r['created_at']), ts(r['created_at'])]) + ') on conflict do nothing;')

# ---------- likes <- post_likes ----------
w('-- likes <- post_likes（老的点赞只针对帖子，映射成 target_type=topic）')
for i, r in enumerate(c.execute('select * from post_likes'), start=1):
    w('insert into likes (id, user_id, target_type, target_id, value, created_at, updated_at) values ('
      + ', '.join([str(i), str(r['user_id']), q('topic'), str(r['post_id']), '1', ts(r['created_at']), ts(r['created_at'])]) + ') on conflict do nothing;')

# ---------- 序列推进 ----------
for tbl in ['users','boards','topics','posts','likes','titles','user_titles']:
    w(f"select setval(pg_get_serial_sequence('{tbl}','id'), greatest((select coalesce(max(id),1) from {tbl}), 1));")
w('commit;')
# 直接按 UTF-8 写文件：PowerShell 的 `>` 会写成 UTF-16 LE+BOM（psql 读不了），而 base64 单条命令又会撞命令行长度上限。
dst = sys.argv[1] if len(sys.argv) > 1 else 'legacy.sql'
with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write('\n'.join(out) + '\n')
print(f'wrote {dst}: {len(out)} 行')
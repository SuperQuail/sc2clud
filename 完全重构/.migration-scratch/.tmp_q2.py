
import sqlite3, sys, json
sys.stdout.reconfigure(encoding='utf-8')
c = sqlite3.connect(r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3')
c.row_factory = sqlite3.Row
tabs = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
print("== row counts ==")
for t in tabs:
    n = c.execute("select count(*) from %s" % t).fetchone()[0]
    print("%-32s %d" % (t, n))
print()
def dump(q, label):
    print("== %s ==" % label)
    for r in c.execute(q):
        print(json.dumps(dict(r), ensure_ascii=False))
    print()
dump("select * from comments order by id", "comments")
dump("select * from post_likes", "post_likes")
dump("select * from comment_votes", "comment_votes")
dump("select * from post_images order by id", "post_images")
dump("select * from post_sources order by id", "post_sources")
dump("select * from titles", "titles")
dump("select * from user_titles", "user_titles")
dump("select * from site_texts", "site_texts")
dump("select * from site_domains", "site_domains")
dump("select * from settings", "settings")
dump("select * from counters", "counters")
dump("select * from notifications", "notifications")

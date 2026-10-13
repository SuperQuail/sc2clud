
import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')
c = sqlite3.connect(r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3')
c.row_factory = sqlite3.Row
for r in c.execute("select id,title,body from posts order by id"):
    print("######## post", r['id'], r['title'])
    print(r['body'])
    print()
for r in c.execute("select key,value from site_texts where key like 'ai_%' or key like 'mail_%'"):
    pass
print("== settings+site_texts keys ==")
for r in c.execute("select key,length(key) from site_texts"): print(r[0], r[1])


import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3'
c = sqlite3.connect(p)
rows = c.execute("select type,name,sql from sqlite_master order by type,name").fetchall()
out = []
for t,n,s in rows:
    out.append("==== %s %s\n%s" % (t,n,s))
open(r'D:\Code\Rust\SC2clud\.tmp_schema.sql','w',encoding='utf-8').write("\n".join(out))
print("tables:", len([r for r in rows if r[0]=='table']))

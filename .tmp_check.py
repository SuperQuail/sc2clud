
import sys, re
sys.stdout.reconfigure(encoding='utf-8')
sql = open(r'D:\Code\Rust\SC2clud\.tmp_import.sql', encoding='utf-8').read()
import sqlite3
c = sqlite3.connect(r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3')
c.row_factory = sqlite3.Row
for r in c.execute("select id,handle,display_name from users order by id"):
    dn = r['display_name']
    cut = dn[:20]
    print("%2d %-14s dn=%-4d cut=%-4d in_sql=%s" % (r['id'], r['handle'], len(dn), len(cut), (repr(cut) in sql)))

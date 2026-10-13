
import sqlite3, sys, json
sys.stdout.reconfigure(encoding='utf-8')
c = sqlite3.connect(r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3')
c.row_factory = sqlite3.Row
for q,l in [("select hash,size,refcount,created_at,owner_id,visibility from blobs","blobs"),
            ("select * from files","files"),
            ("select * from image_jobs","image_jobs"),
            ("select * from mail_accounts","mail_accounts"),
            ("select * from audit_log order by id limit 12","audit_log head"),
            ("select action, count(*) n from audit_log group by action order by n desc","audit actions"),
            ("select * from sessions limit 3","sessions"),
            ("select * from group_section_rules","group_section_rules"),
            ("select * from user_groups","user_groups"),
            ("select * from ai_secrets","ai_secrets"),
            ("select substr(body,1,400) body, id, author_id, section from posts order by id","post bodies"),
            ("select min(created_at),max(created_at) from users","ts range"),
            ]:
    print("== %s ==" % l)
    for r in c.execute(q): print(json.dumps(dict(r), ensure_ascii=False)[:700])
    print()


import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')
c = sqlite3.connect(r'D:\Code\Rust\SC2clud\backups\old-prod-2026-10-12\sc2clud.sqlite3')
c.row_factory = sqlite3.Row
print("-- users --")
for r in c.execute("select id,handle,email,substr(password_hash,1,60) ph,role,quota_bytes,used_bytes,created_at,disabled_at,activated_at,display_name,avatar_hash,avatar_mime,trusted,level,exp,equipped_title_id,donation_visible,donation_notice_visible,substr(donation_notice_text,1,20) dnt,substr(bio,1,20) bio,bio_review_state,default_avatar_hash,avatar_small,post_ban_until,donation_records_public from users"):
    print(dict(r))
print("-- sections --")
for r in c.execute("select * from sections"): print(dict(r))
print("-- posts --")
for r in c.execute("select id,author_id,title,created_at,updated_at,deleted_at,kind,review_state,review_note,reviewed_at,reviewed_by,auto_reviewed,image_count,section,archived_at,pinned_rank,pinned_at,pinned_by,featured_at,featured_by,pushed_at,resource_status,resource_status_at,length(body) blen from posts"):
    print(dict(r))

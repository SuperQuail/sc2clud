set -u
DSN=$(grep -E '^FORUM_DB__DSN=' /etc/sc2clud/dev.env | cut -d= -f2-)
echo "--- BEFORE"
psql "$DSN" -Atc "select public_id,title,visibility from topics where public_id in ('3db0425a-1053-5011-8484-a58e828fdd4d','01a13540-ff54-7f07-a975-51e08a5f831c') order by public_id" 2>&1

# 1) 还原被我改名的别人主题：只改 title，且要求当前 title 就是脚本写坏的那个字面量（双条件，避免误伤）
psql "$DSN" -Atc "update topics set title='火力全开系列战役Mod', updated_at=now() where public_id='3db0425a-1053-5011-8484-a58e828fdd4d' and author_id <> (select id from users where username='probe-admin') and title='[盲测]越权改名';"
echo "--- restore rc=$?"

# 2) 删掉我自己跑出来的残留行：author_id 必须是 probe-admin，标题必须带 [盲测] 前缀
psql "$DSN" -Atc "delete from posts where topic_id in (select id from topics where author_id=(select id from users where username='probe-admin') and title like '[盲测]%');"
psql "$DSN" -Atc "delete from likes where user_id=(select id from users where username='probe-admin') and target_type='topic' and target_id in (select id from topics where author_id=(select id from users where username='probe-admin') and title like '[盲测]%');"
psql "$DSN" -Atc "delete from bookmarks where user_id=(select id from users where username='probe-admin') and topic_id in (select id from topics where author_id=(select id from users where username='probe-admin') and title like '[盲测]%');"
psql "$DSN" -Atc "delete from reports where reporter_id=(select id from users where username='probe-admin') and target_type='topic' and target_id in (select id from topics where author_id=(select id from users where username='probe-admin') and title like '[盲测]%');"
psql "$DSN" -Atc "delete from topics where author_id=(select id from users where username='probe-admin') and title like '[盲测]%';"
echo "--- cleanup done"

echo "--- AFTER"
psql "$DSN" -Atc "select public_id,title,visibility from topics where public_id in ('3db0425a-1053-5011-8484-a58e828fdd4d','01a13540-ff54-7f07-a975-51e08a5f831c') order by public_id" 2>&1
echo "--- 残留 [盲测] 主题数"
psql "$DSN" -Atc "select count(*) from topics where title like '[盲测]%'" 2>&1
echo "--- 残留 bt- 回复数"
psql "$DSN" -Atc "select count(*) from posts where content_md like '%bt-%' and content_md like '%盲测%'" 2>&1
echo "--- 主题总数（应为 30，即回到 31-1）"
psql "$DSN" -Atc "select count(*) from topics" 2>&1
echo "--- 全库 [盲测] 痕迹（任何表里带这个前缀的标题）"
psql "$DSN" -Atc "select count(*) from topics where title like '%盲测%'" 2>&1

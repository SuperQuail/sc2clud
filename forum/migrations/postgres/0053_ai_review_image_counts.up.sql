-- 0053_ai_review_image_counts：审核留痕要能回答「这次判了几张图、截了几张」（D33③，2026-10-15 用户拍板真做多模态）。
--
-- 为什么是新列、而不是事后按 topic_images 重算：图集是**可变的** —— 作者事后加一张图、删一张图，
-- 重算出来的就是「现在有几张」，而不是「判定那一刻发了几张」。这条记录要固定的正是后者
--（申诉、复盘「AI 为什么会判错」时唯一能信的数）。
--
-- 两列都是 0 默认：0053 之前的历史事件本来就没有图（那时一个字节都不上行），0 是**真话**不是占位。
ALTER TABLE review_events
  ADD COLUMN image_count   int NOT NULL DEFAULT 0,
  ADD COLUMN image_skipped int NOT NULL DEFAULT 0;
-- 不写「检查刚才那个 ALTER 成功没有」的断言：ALTER 失败会自己中断整个迁移，
-- 那种断言永远为真（本仓库把「永远通过的检查」当缺陷）。

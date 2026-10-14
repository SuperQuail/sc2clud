-- 0029_topic_revisions_pending：编辑不动原帖、通过再替换（拍板 08 第二轮 · 6.2）。
--
-- 用户原话：「做,编辑不动过审替换」→ 按老站语义：「作者编辑时不动原帖（线上仍是最后一个
-- 过审版本），审核通过后才替换」。
--
-- 0028 的 topic_revisions 只有一份内容，语义是「最后过审版本」，而作者一改正文就写进
-- posts（= 线上那一份）—— 于是**未过审的改动立刻对所有人可见**，与老站语义正好相反。
--
-- 这一版把这一张表变成主题正文的**三个版本**（一帖一行，uq_topic_revisions_topic 不变）：
--   · content_md / content_html + approved_at —— **线上版本**，也就是最后一次过审的那一份。
--     线上那一份在 posts（floor=1），这一份是它的快照；读者看到的永远是它。
--   · pending_md + pending_at —— **待审版本**（作者改完、还没过审的那一份）。只有作者看得到：
--     TopicDetailDTO.content_md 在「读的人是作者」时换成它（forum/map.go）。
--   · 没有行 = 这条主题**从没过审**。那时作者改正文仍然写 posts（那本来就是作者自己的内容，
--     别人看不到），所以「待审版本」只在有过审记录的主题上才需要单独存。
--
-- 不新开一张表：一份待审内容一帖最多一份，而 topic_revisions 的 uq_topic_revisions_topic
-- 本来就是「一帖一行」—— 加两列就能表达，新表只会多一处要与它同步的状态。

ALTER TABLE topic_revisions ADD COLUMN pending_md   text        NULL;
ALTER TABLE topic_revisions ADD COLUMN pending_html text        NULL;
-- 「这份待审内容是什么时候写的」。没有它，后台 / 作者页就只能靠 topics.updated_at 猜，
-- 而那个列被标题、分区、阅后即焚的计数一起推新（判定时它还要当版本号用）。
ALTER TABLE topic_revisions ADD COLUMN pending_at   timestamptz NULL;

-- 两列必须同生同死：只写一半会让「有没有待审版本」这个判据（pending_md IS NOT NULL）
-- 与渲染用的 html 对不上 —— 那种行渲染出来是空正文，而看起来一切都正常。
ALTER TABLE topic_revisions ADD CONSTRAINT ck_topic_revisions_pending
  CHECK ((pending_md IS NULL) = (pending_html IS NULL) AND (pending_md IS NULL) = (pending_at IS NULL));

-- 0030_users_cover_hash：个人主页的封面 / 背景（拍板 08 第二轮「壁纸替换」）。
-- 号是 Lead 点的（0029 被 L6 的 topic_revisions_pending 先占了）。
--
-- 用户原话：「做好,这不应该是WIP」+ 09 收尾对照表 §8 记的「个人主页的背景/封面替换同样要通
-- （用户早前报过"用户主页设置背景功能消失"）」。上一版屏幕上那颗「更换封面」点了没有任何反应，
-- 根因不是控件坏了：users 没有封面列、media 也没有封面通道，按钮背后根本没有东西可写。
--
-- 形状与 boards.cover_hash 逐字同构（d3-forum §3.2）：char(64) 引用 images(hash)，
-- 内容寻址（d5-content：站点只有一条图片读路径 /img/{hash}），ON DELETE SET NULL ——
-- 图片被 GC 时用户不会跟着消失（与 users.avatar_hash 同一口径）。
--
-- 为什么是「封面」而不是另开一张 user_profiles 表：这是 users 上的第 4 根图片列，
-- 与三根头像列同一形状、同一读写路径（media 域的图片通道 + /img 直出），
-- 多一张 1:1 的表只会多一处 join 与一处漂移点。

ALTER TABLE users ADD COLUMN cover_hash char(64) NULL
  REFERENCES images(hash) ON DELETE SET NULL;

-- 单列外键索引：ON DELETE SET NULL 要扫这一列（数据库设计 §12 第 1 条）。
CREATE INDEX idx_users_cover ON users (cover_hash);

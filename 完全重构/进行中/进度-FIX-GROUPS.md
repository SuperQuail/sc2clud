# FIX-GROUPS 进度（D38 用户组系统 + D39 分区屏清理 + D40 超管呈现）

派单：完全重构/进行中/10-dev排查-缺陷清单.md §1k。语义口径照 Lead 钉死的四条：
① 组授是**加法授权**（acl_enabled 白名单下多一条可发/可回的路径）；
② 显式 deny（角色行或组行任一层）**终局**；
③ superadmin 的 is_super 语义照旧（canSpeak 第 1 步短路，矩阵不控制它）；
④ 禁言 → acl_enabled → ACL/组授、等级门槛最末的既有顺序不动（迁移 0027 同款）。

- [x] 报号并建迁移 0055（动手前复核 forum/migrations/postgres 最大号 = 0054，FIX-MAILTPL 占用）
  - 证据：目录清点 0054_mail_templates.* 为最大号；0055_user_groups.up.sql 建 user_groups / user_group_members / board_group_acls 三表 + FK 索引 + ck_board_group_acls_no_contradiction（照 0004 的矛盾 CHECK 同款）
  - 下一步：pgsql/user_groups.go 与 ACLRowFor 的组列（组授 / 组 deny / 板上有无组规则）
  - 阻塞：无
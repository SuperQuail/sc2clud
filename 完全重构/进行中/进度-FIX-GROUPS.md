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

- [x] 组员管理按 key 化必须在同一事务里锁分区行——把 PUT 矩阵改成 **group_key** 交上来（组目录对外是 key，自增 id 不出 API 拍板同款）：pgsql GroupsExistByKey/GroupIDsByKey + SetAdminGroupACL 里 key→id 映射；回执/审计照 key 记
  - 证据：go test ./internal/forum/ -run 'TestAdminGroup|TestAdminBoardGroupACL|TestGroupAcl' ok（矩阵替换 / 三处不静默 / 全量删行 / 组员生效即时）
  - 下一步：前端全链（api/groups.ts、keys、rooms、routes）
  - 阻塞：无

- [x] 前端全链：组屏（groups.tsx：目录/建组/组资料/组员管理/删组确认）+ 按组名单矩阵（boards-acl.tsx 的 GroupAclPanel）+ 分区屏超管行锁定「全域继承」（勾选禁用 + 原因句 + 保存路径滤掉 is_super 行并在回执说明）+ D39 管理员口径清理（ScreenHead/资料/排序/发言权限/版主/危险动作 + ACL 面板的 D6 步骤块整体改成人话）+ nav/route 挂接（perms: 组屏 user.ban；分区组矩阵 board.manage）
  - 证据：pnpm typecheck 绿；pnpm lint（本人六文件 0 警告）；npx vitest run **63 文件 310 用例全绿**（含 groups.test.tsx 三条新用例）
  - 下一步：DevRoom 出图（?screen=groups 与 ?screen=boards，1440/390）；整包 go test 收口
  - 阻塞：无

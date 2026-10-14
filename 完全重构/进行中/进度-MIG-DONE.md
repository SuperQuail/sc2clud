# 进度 · MIG-DONE（第三轮拍板的三条「完全迁移」）

> 依据：`完全重构/进行中/10-dev排查-缺陷清单.md` §1c（用户第三轮拍板，逐字照做）。
> 作用域：`forum/internal/app/**`、`forum/internal/forum/**`、`forum/migrations/postgres/**`、
> `完全重构/迁移素材/**`、`完全重构/数据迁移审计.md`、本文件。**不碰** `web/src/**`、`deploy/**`。

- [x] 迁移号取证 + 第1步：公告区权限的**会红用例**先落地（还没修）
  - 做了什么：新建 `forum/internal/app/announcement_acl_test.go`：真迁移 → `Seed` → 真服务，
    三条断言 —— ①公告区 `acl_enabled=true` 且四个内置角色各一行 ACL；②普通用户（种子 `demo-thor`，
    持 `topic.create`）发公告区 → `board.acl_denied`；③管理员（`demo-admin`）发帖成功、普通用户**仍能回复**
    （老站 `reply_min_role='member'` 那一档不能一起收紧）。先用例、后改库：这条现在**必须是红的**。
  - 证据：`go test ./internal/app/ -run TestAnnouncementBoardOnlyAdminsCanPost -count=1 -v`
    → `announcement_acl_test.go:56: 公告区 acl_enabled 不是 true：角色门槛只能靠 board_acls 表达
    （min_post_level 是等级，不是角色）` + `--- FAIL` + `FAIL forum/internal/app 9.710s`。
    老站真值（只读备份 `backups/old-prod-2026-10-12/sc2clud.sqlite3`）：
    `announcement|公告|站点通知（只有管理员能发）|admin|member`。
  - 下一步：新增迁移 `0031_announcement_acl.up.sql/.down.sql`（`acl_enabled=true` + 四角色行，
    回复档按老站放开）→ 这条用例转绿；同一步顺手改 `seed_data.go` 的两处中文名。
  - 阻塞：无。**迁移号取证**：现有最高是 `0030_users_cover_hash`（`forum/migrations/postgres/` 里 0029/0030 已占），
    本包从 **0031** 起，未与任何在途分支撞号。

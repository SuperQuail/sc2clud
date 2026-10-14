# 进度 · MIG-DONE（第三轮拍板的三条「完全迁移」）

> 依据：`完全重构/进行中/10-dev排查-缺陷清单.md` §1c（用户第三轮拍板，逐字照做）。
> 作用域：`forum/internal/app/**`、`forum/internal/forum/**`、`forum/migrations/postgres/**`、
> `完全重构/迁移素材/**`、`完全重构/数据迁移审计.md`、本文件。**不碰** `web/src/**`、`deploy/**`。
> 验证口径：后端 `gofmt -l .` + `go vet ./...` + 改过的包 `go test -count=1`（不用 `-run` 过滤整包收尾）；
> **不跑 `pnpm check`**（清 dist、与并发的人互踩），本包一行前端也不碰。

- [x] 迁移号取证 + 第1步：公告区权限的**会红用例**先落地（还没修）
  - 做了什么：新建 `forum/internal/app/announcement_acl_test.go`：真迁移 → `Seed` → 真服务，
    断言 ①公告区 `acl_enabled` + 四个内置角色**逐角色**的 (can_post, can_reply)；②普通用户
    （种子 `demo-thor`，持 `topic.create`）发公告区 → `board.acl_denied`；③管理员（`demo-admin`）发帖成功、
    普通用户**仍能回复**（老站 `reply_min_role='member'` 那一档不能一起收紧）。先用例、后改库。
  - 证据：`go test ./internal/app/ -run TestAnnouncementBoardOnlyAdminsCanPost -count=1 -v`
    → `announcement_acl_test.go:56: 公告区 acl_enabled 不是 true：角色门槛只能靠 board_acls 表达
    （min_post_level 是等级，不是角色）` + `--- FAIL` + `FAIL forum/internal/app 9.710s`（TEST_EXIT 非 0）。
    老站真值（只读备份 `backups/old-prod-2026-10-12/sc2clud.sqlite3`）：
    `announcement|公告|站点通知（只有管理员能发）|post_min_role=admin|reply_min_role=member`。
  - 下一步：把执法点落进 `seed`（`seedAnnouncementACL`）并改 `seed_data.go` 的中文名 → 用例转绿。
  - 阻塞：无。**迁移号取证**：`forum/migrations/postgres/` 现有最高是 **0051**（`0051_board_moderator_grown`；
  0029/0030/0040/0050 都已占），`migrations.Latest()` 实测 = **51**。本包**没有新增迁移**
    （原因见第2步），将来真要加从 **0052** 起。
- [x] 第2步：公告区「只有管理员能发」真的落地（老站语义 = ①ACL 白名单）
  - 做了什么：**先写了一条 0031 迁移又删掉** —— 迁移在空库上跑（`migrate` 早于任何分区存在），
    `WHERE b.slug='announcement'` 一行都命中不到，实测 `board_acls rows=0`；而顺序号必须 > 0051 才排在
    `0050_boards_public_id` 之后，编号语义也会乱（编号是**类型**不是时间）。改成落进 `forum seed`：
    `seed.go` 在 `seedBoards` 之后调 `seedAnnouncementACL(ctx, in.Pool)`（`seed_data.go` 里实现）——
    它读现状、与目标比对、只改不一致的行；目标 = 四个内置角色 `admin/superadmin` 能发、
    `user/creator` 不能发，**回复一律放开**；自定义角色按「名字含『管理员』」收敛。
    选择理由（按老站语义，不按哪条好写）写在函数注释里：②加 `min_post_role` 列在新站**不能少写一个字**
    （0017 四个内置角色 `parent_id` 全 NULL，角色之间没有继承，「admin 及以上」照样列两行），
    只是把规则放到第二个地方；③接受一档等于让这句话在真站上是假的。①的代价（白名单制把回复也管住）
    正好与老站同形（`reply_min_role='member'`）。
    `seed_data.go` 同时改两个中文名：`工具（玩家）`→`工具（玩家用）`、`工具（开发者）`→`工具（开发者用）`。
    **已存在的行**由 `seedBoards` 的 default 分支（`SetName`）收敛 —— 用例正是钉这一条。
  - 证据：`go test ./internal/app/ -run TestAnnouncementBoardOnlyAdminsCanPost -count=1 -v`
    → `seed: ok, boards=5 users=11 topics=25 posts=75 announcement_acl_changed=5` + `--- PASS` + `ok 10.483s`；
    `-run 'TestSeedAnnouncementACLIsIdempotent|TestBoardNamesConvergeToSeed'` → 两条 `--- PASS`、`ok 10.571s`
    （幂等那条先断言 first>0 再断言 second=0；名字那条先把 `tool-player` 改回旧名再跑 seed，要求变回来）。
  - 下一步：AI 配置的值也做成迁移资料（`完全重构/迁移素材/ai-config.json` + `forum ai-config` 导入命令 + 用例）。
  - 阻塞：无。

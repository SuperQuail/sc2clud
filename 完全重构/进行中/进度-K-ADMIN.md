# 进度 · K-ADMIN（后台最后两屏：users 逐字段复核 + boards 接线）

> 任务书：**逐字段复核** `AdminUser` / `AdminBoard`（拿 `forum/internal/**` 的真 JSON 字段名核 W-D2 推出来的类型，
> 对不上的**按后端改**）、把 `routes/admin.tsx` 里 users / boards（+ diagnostics，C3 也已落地）的 `PendingScreen`
> 换成真容器、出图并看图（含非默认态与 390 窄屏）。
> 作用域：`web/src/routes/admin/**`、`web/src/lib/api/admin.ts`、`web/src/lib/api/admin-types.ts`、
> `web/src/devroom/pages/15-admin/screens/{users,boards}.tsx`、`web/src/routes/admin.tsx`、本文件。**不碰 `forum/**` 一行**。
> 收工命令（**不跑 `pnpm check`**）：`cd web && pnpm typecheck && pnpm lint && npx vitest run`；`node scripts/check-budget.ts`。

## 变更

- [x] 第 1 步：逐字段复核 `AdminUser`，按 `forum/internal/auth/admin_users.go` 改类型 + users 屏与容器接详情
  - 做了什么：`admin-types.ts` 的 `AdminUser` 重写为 **AdminUserDTO 的逐字段**，新增 `AdminUserRoleRef` / `AdminSanction` /
    `AdminGrant` / `AdminUserTitle` / `AdminUserDetail`；`admin.ts` 加 `fetchUserDetail` 并修掉三条贴错位置的注释
    （「后端还没有这条路由」在 C1 落地后是假话）；`routes/admin/users.tsx` 选中一行才取详情（三张表只有详情接口给），
    右栏的追加权限/处罚改成真字段；`screens/users.tsx` 的 role 列去掉 `sortable`（列表项没有 `priority` 可排）。
  - **逐字段对账（W-D2 推的 → 后端的真字段）**：
    | W-D2 的类型里 | 后端（auth/admin_users.go） | 处理 |
    |---|---|---|
    | `avatar: string\|null` | **不存在**（AdminUserDTO 不回头像） | 删；屏上 `src={null}` |
    | `role: Role`（带 id/perm_keys/priority/user_count） | `AdminUserRoleRef{key,name,badge_color}` | 改成三列的类型；「改角色」用 key 去 /admin/roles 换 id |
    | `extra_permissions: ExtraPerm[]` | **列表项里没有**；详情给 `user_permissions: AdminGrantDTO[]`（**带 reason 与 name**） | 拆成 `AdminUserDetail.user_permissions` |
    | `title: {name,color}\|null` | **列表项里没有**；详情给 `user_titles: AdminTitleDTO[]`（数组，带 granted_at/archived_at） | 拆成 `AdminUserDetail.user_titles` |
    | `sanctions: {kind,scope,until,reason}[]` | **列表项里没有**；详情给 `sanctions: AdminSanctionDTO[]`，字段是 `id:number / action:post\|reply\|all / board:{slug,name}\|null / until\|null / created_at` | 屏上按 `action` + `board` 渲染（mock 的 `mute_post` 是编的） |
    | （缺）`level: number` | `level int` 在 DTO 里 | 补上 |
    | `email_verified_at` / `activated_at` / `trusted` / `status` / `topic_count` / `reply_count` / `last_login_at` / `created_at` / `id` / `username` / `nickname` / `email` | 逐个都对上 | 保留 |
  - 证据：`npx tsc --noEmit` → **0 错**（整仓，含别人的在途文件）；`npx eslint src/routes/admin src/routes/admin.tsx src/lib/api/admin.ts src/lib/api/admin-types.ts src/devroom/pages/15-admin` → **0 error**；
    `npx vitest run` → `Test Files 34 passed (34) / Tests 168 passed (168)`。
  - 下一步：`AdminBoard` 逐字段复核 + boards 屏接真容器（`routes/admin/boards.tsx`）。
  - 阻塞：无（`GET /admin/users`、`GET /admin/users/{id}` 已由 W-D1 的 `7710d26` 落地并在 `auth/handler.go` 挂上了路由）。
- [x] 第 2 步：`AdminBoard` 逐字段复核 + boards 屏接真容器（C2 的 9 条路由）
  - 做了什么：`admin-types.ts` 新增 `AdminBoard` / `AdminModerator` / `AdminModeratorItem` / `AdminACLItem` /
    `CreateBoardInput` / `UpdateBoardInput`；`admin.ts` 加 9 个客户端函数（列表/建/改/重排/ACL 读与全量替换/版主三条）；
    `keys.ts` 加 `adminBoards` / `adminBoardAcl` / `adminBoardModerators` / `adminUserDetail`；
    `screens/boards.tsx` 改成 prop 驱动（草稿在屏里，宿主只发号 `savedAt`）、`screens/boards-acl.tsx` 与
    `boards-acl-model.ts` 改吃真 DTO；新建容器 `routes/admin/boards.tsx`；`routes/admin.tsx` 的映射表把
    `PendingScreen('boards')` 换成 `BoardsScreenContainer`。
  - **逐字段对账（mock/旧类型 → 后端）**：
    | 旧类型（mock/content.ts） | 后端（forum/admin_boards.go） | 处理 |
    |---|---|---|
    | `sort: number` | **没有 sort**，展示用的是 `position`（`row_number() OVER (ORDER BY sort, id)`） | 改 `position`；重排走 `POST /admin/boards/reorder {ids}`（**必须给全部**，少一个 400） |
    | `cover_file: string`（public/art 下的文件名） | `cover_hash: string`（**空串 = 没有封面**，后端把 NULL 折成空串） | 改 `cover_hash` → `/img/{hash}`；没有上传端点，也不画「清空」（传空串会被 UpdateBoardInput 折成 nil = 不动） |
    | `acl_enabled / topic_count / post_count / today_count / status / slug / name / description` | 逐个对上 | 保留 |
    | （缺）`min_post_level: number` | DTO 里有 | 补上，可编辑 |
    | 版主在另一个数组 `BOARD_MODERATORS[{board_id,user,expires_at}]` | 列表项带 `moderators: AdminModerator[]{user_id,handle,nickname,granted_at,expires_at}`（**只有在任**）；`GET .../moderators` 给**含已卸任**的 `grown_at` | 用列表项那一份 + 单独的版主读口（历史任期） |
    | `BoardAcl{board_id,role_id:string,...}` | `AdminACLItem{role_id:number, role_key, can_post, can_reply, deny_post, deny_reply}` | 矩阵按 `role_id`（数字）索引；`aclOf()` 那种「找不到就当全 false」的兜底删掉 |
    | mock 的「删除分区」按钮 | **没有删除端点**（§21.2 只有建/改/重排） | 不画（画一颗点了必然 404 的按钮是最坏的一种「看着正常」） |
    | mock 的 slug 可编辑 | PATCH 的 body 连 slug 字段都不收 | 编辑态只读 |
    | mock 的「上移/下移」改本地 `sort = (i+1)*10` | 后端认整个 `ids` 顺序 | 换位后把**全部 id**发上去 |
  - 一处**顺手对齐**：ACL 的「允许」与「禁止」在同一行互斥（后端 service 逐条校验 + `ck_board_acls_no_contradiction` 都拦），
    所以勾一边就把对面关掉 —— 不把一条必 400 留给用户去撞。
  - 证据：`npx tsc --noEmit` → **0 错**；`npx eslint src/routes/admin src/routes/admin.tsx src/lib/api src/devroom/pages/15-admin` → **0 error**；
    `npx vitest run` → `Test Files 34 passed (34) / Tests 168 passed (168)`；`node scripts/check-size.ts` → `检查 296 个文件，超限 1 个，登记 1 个` + 通过（唯一超限的是别人的 `routes/messages.tsx 646 行`）。
  - 下一步：`GET /admin/diagnostics`（C3）也已落地 → 把 `PendingScreen('diagnostics')` 换成容器，并删掉没人用的 PendingScreen 工厂。
  - 阻塞：无（C2 的 9 条路由在 `forum/internal/forum/handler.go` 125–134 行；`boards.public_id` 由迁移 0050 补上）。
- [x] 第 3 步：`GET /admin/diagnostics`（C3）也翻成真容器 —— **12 屏的映射表里再没有占位屏**
  - 做了什么：`admin-types.ts` 加 `DiagnosticCheck` / `Diagnostics`（照 `auth/admin_diagnostics.go` 的 `DiagnosticCheckDTO` /
    `DiagnosticsDTO`）；`admin.ts` 加 `fetchDiagnostics`；`screens/diagnostics.tsx` 改成 prop 驱动；
    新建容器 `routes/admin/diagnostics.tsx`；`routes/admin.tsx` 换成 `DiagnosticsScreenContainer`；
    **删掉 `_shared.tsx` 里的 `PendingScreen` 工厂与 `PENDING_SCREENS` 表**（不再有使用者；
    留着一个没人用的占位屏，下一个人就会以为还有哪一屏没接）。
  - **照后端纠正三处**：① 检查项是**三态** `ok|fail|skipped`，不是 mock 的布尔 ——「没查」显示成「通过」是这类面板最常见的假绿，
    所以 `skipped` 单独一档、单独一个计数；② **debug 关闭时端点整体 404**（`common.not_found`，不是空 200），
    所以拿不到数据时屏上写「这一档是预期内的：关掉了」而**不是**渲染一张空表（空表看起来像「跑了没问题」）；
    ③ mock 的「重建索引 / 清理图片缓存 / 立即备份」三颗按钮**一个都不画**：后端没有这些端点，而 mock 用来门控它们的
    `system.settings` 在后端 `authz.go` 的常量表里**根本不存在**。
  - 证据：`npx tsc --noEmit` → **0 错**；`npx eslint src` → `19 problems (0 errors, 19 warnings)`（全是既有的 react-refresh 告警，我的文件里没有 error）；
    `npx vitest run` → `Test Files 34 passed (34) / Tests 168 passed (168)`；`node scripts/check-size.ts` → 通过。
  - 下一步：出图（`web/scripts/shoot-admin.ps1`）+ 看图（默认态 / 空 / 错误 / 无权限 / 390 窄屏），然后跑 `node scripts/check-budget.ts`。
  - 阻塞：无。

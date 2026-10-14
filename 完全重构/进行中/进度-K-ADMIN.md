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

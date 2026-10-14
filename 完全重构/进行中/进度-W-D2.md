# 进度 · W-D2（后台 12 屏接线）

> 交接单 §4.D。开工基线与协议见 `07-一次性完工交接单.md`。
> 每完成一屏一个 commit，本文件在同一 commit 里更新（四行：做了什么 / 证据 / 下一步 / 阻塞）。

## 变更
- [x] **接线地基**：新建 `web/src/lib/api/admin.ts`（+ `admin-types.ts`）把实测的 /admin/* 端点的**真字段名**落成客户端；`routes/admin.tsx` 改用 `AdminShell`（面包屑 + 当前管理员卡 + 权限明细）、权限点改成**后端 authz 常量那唯一一套**并删掉「perms 为空就不拦」的放宽；新建 `routes/admin-screens.tsx` 放**每屏一个取数容器**；**users 屏改成 prop 驱动**并接上已实装的四个动作端点（改角色 / 封号 / 踢会话 / 发头衔）与 `/admin/roles`、`/admin/titles`。
  - 证据：`cd web && npx tsc --noEmit` → 无输出（0 错）；`npx vitest run` → `Test Files 28 passed (28) / Tests 147 passed (147)`；`pnpm lint` → 仅 2 个 error，都在**别人在途的** `web/.tmp-wfi-scan.cjs`（`no-require-imports`），我的文件只有既有的 react-refresh warning。字段名逐个对过：`/admin/roles` → `auth/service.go RoleItem`（`badge_color`/`perm_keys`/`user_count`）、`/admin/titles` → `title/types.go TitleDTO`（`archived_at` **不是** mock 里的 `archived` 布尔 + `holders`）、`banReq` → `auth/handler.go:141`（`action` 只有 ban|unban）。
  - 下一步：**review 屏**（`screens/review.tsx`）改成 props 驱动，容器加进 `routes/admin-screens.tsx`；端点 `GET /admin/topics?state=&board=&q=&limit=&cursor=`（→ `{data,next_cursor}`）与 `POST /admin/topics/{id}/review` **body 必须带 `expected_updated_at`**（队列项的 `updated_at`，不带就 400），字段照 `forum/review_queue.go ReviewQueueItemDTO`；`review_verdict` 取最近一条 `review_events` 的结论、**不能从 `review_state` 三态推**（交接单 C11）。
  - 阻塞：**这一屏的数据端点 `GET /admin/users` 还不存在**（交接单 C1，W-D1 在补：他的 `forum/internal/auth/admin_users.go` + `auth/pgsql/admin_users.go` 已在工作区、未跟踪）。没有它时宿主拿到 404，屏上如实显示「用户列表没能加载（HTTP 404）」——**没有拿示例数据兜底**。剩下的 `boards` / `diagnostics` 两屏同理（C2 / C3），已在 `routes/admin-screens.tsx` 的 `PENDING_SCREENS` 里写明缺哪条端点。

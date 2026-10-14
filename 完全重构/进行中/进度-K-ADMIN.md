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
- [x] 第 4 步：侧栏 badge 摘掉（不接假件数）+ 两条后端缺口写进阻塞
  - 做了什么：`15-admin/nav.ts` 的四条 `badge`（users 12 / review 4 / reports 3 / rewards 4）**删掉**，
    `shell.tsx` 的 `count` 传参与 `side-nav.tsx` 的 `count` prop + `CountBadge` 一并删（它唯一的使用者就是那四个假数）。
  - **为什么摘掉而不是接真件数**（两条都是实测的，不是懒）：① 后端**没有这几个计数读口** ——
    列表接口只给 `next_cursor`（`GET /admin/users` 的游标是 base64(id)，翻到底才知道有多少），
    拿本页条数当「待处理总数」是**少报**，比不显示更坏；② 侧栏在**每一屏**都渲染，挂四屏的计数查询
    会在切进后台的第一秒一起发出去。等哪天后端给了这几个计数端点再挂回来（届时 nav.ts 里那几行说明就是落点）。
  - 证据：`npx tsc --noEmit` → 0 错；`npx eslint src` → `19 problems (0 errors, 19 warnings)`（与开工前同一批既有告警）；
    出图 `users`/boards 侧栏已经没有数字（`shots/kadmin/users-1440.png` 等 12 张全看过）。
  - 顺带：屏上**可见文案**里以前写成 markdown 的 `**强调**`（`hint` / `note` 是纯文本，星号会原样显示）
    在 users / boards / boards-acl / diagnostics 四个文件里清掉 —— 是出图时在图里看见的，不是靠读代码发现的。
  - 下一步：无（本轮任务 1–4 全部落地）。
  - 阻塞：**`POST /admin/ai/test` 不绑定任何入参、且没有 `/admin/ai/stats`** —— ① 试跑只能跑配置里那段提示词 +
    固定短文本，**没法拿某一篇真实内容试**（要做得先给 test 加 `{title, content, trigger}`）；
    ② 没有用量读口（调用次数 / 失败率 / 最近错误聚合），所以 ai 屏上「用量与失败率」两栏**没有画**
    （W-D2 已把它们删掉，本轮复核确认后端确实没有，见 `forum/internal/aireview/dto.go` 只有 `ConfigView` / `TestView`）。
    这两条是**后端缺口**，前端没有造兜底。

## 收工状态（2026-10-14）

**任务 1–4 全部落地**：`AdminUser` / `AdminBoard` 逐字段复核完（按后端改，见第 1、2 步的对账表）；
`routes/admin.tsx` 的 12 屏**全部是容器**，`PendingScreen` 工厂已删；出图 20 张并逐张看过（含空/错误/无权限/390 窄屏）。

### 验收证据（本轮最后跑的一次）

- `cd web && npx tsc --noEmit` → **无输出（0 错）**，整仓（含别人在途的文件）。
- `cd web && npx vitest run` → `Test Files 34 passed (34) / Tests 168 passed (168)`。
- `cd web && npx eslint src` → `19 problems (0 errors, 19 warnings)` —— **与开工前逐条相同**（都是既有的
  `react-refresh/only-export-components` 与 `markdown-editor` 的 `exhaustive-deps`，不是我的文件）。
- `cd web && node scripts/check-size.ts` → `检查 296 个文件，超限 1 个，登记 1 个` + `文件体量门禁通过`
  （唯一超限的是**别人的** `routes/messages.tsx 646 行`，已在 PENDING 里登记）。
- `node scripts/check-budget.ts`：**没有重跑** —— 它量的是 `dist/` 里的产物，而 `dist/` 现在是
  **15:15 的旧构建**（比我的改动早）。为了那一个数字去 `pnpm build` 会清空 `dist/`，与别人正在跑的
  `pnpm check` 互踩（交接单 §3 第 5 条）。**结构上的保证**：我这一轮没有碰 `src/main.tsx`、
  `app/router.tsx`、`app/shell.tsx`、`styles/**`，唯一的入口级改动是 `routes/admin.tsx` 的映射表 ——
  而 `/admin/*` 在 `router.tsx` 里是 `lazy` 的（`routes/admin` 一个独立 chunk），所以首屏 JS 一个字节都没动。
  上一轮同样的改动之后量到的是 `首屏 JS 148.7 KB / 150.0 KB`、`最大路由 chunk 96.0 KB / 120.0 KB` + 通过。
  **给 Lead 的一句话**：合这一轮之后串行跑一次 `pnpm check` 就能把这条补齐。
- 后端：**没有碰 `forum/**` 一行**，所以不需要跑 Go 测试。

### 出图（`web/scripts/shoot-admin.ps1`，端口 5230，收工按 PID 关掉；产物在 `shots/kadmin/`）

| 图 | 字节 | 关键内容（看过的） |
|---|---|---|
| `users-1440` | 144489 | 5 行真数据（含 1 封禁 / 2 待激活 / 1 邮箱未验证），三根状态轴分列；「本页用户 5」注明后端不给总数 |
| `boards-1440` | 132381 | 4 个分区（含 1 归档）、position 1/4、统计 2471 帖 / 今日 28、能改的都来自 DTO 真字段 |
| `diagnostics-1440` | 106064 | 三态：2 通过 / 1 异常 / 1 **没查**（mock 的布尔版会把「没查」显示成通过） |
| `boards-empty-1440` | 69580 | 空态：四张统计卡全 0 + 「还没有分区」+ 右栏「先建一个分区」 |
| `boards-error-1440` | 73813 | 错误态：`分区列表没能加载（HTTP 500）：服务端内部错误（出图桩：?fail=1）（编号 req-shot）` |
| `boards-noperm-1440` | 27166 | 无权限态（`-NoAdmin`）：`没有这一屏的权限 / 当前账号缺少 board.manage`，**一条 /admin/boards 请求都没发** |
| `users-noperm-1440` | 26415 | 同上，缺 `user.ban` |
| `users-narrow-390` / `boards-narrow-390` | 45367 / 48835 | 390 宽：导航折成横排 chip、统计卡换行、列表可横向滚动，无文字被压成 0 宽 |
| 其余 8 屏 | 72507–151195 | 回归：12 屏全部 `OK`、`失败 0 张`（我改了 `boards-acl-model` 与导航，所以把别人那 10 屏也重拍了一遍） |

每张图左下角都有 `MARKER-ADMIN /admin/<屏>`（证明拍的是当前源码），并且**每张都走 `stub=1` 的桩**。

### 出图期间修掉的两个脚手架坑（下一步的人会踩）

1. **`?empty=1` / `?fail=1` 一开始完全不生效**：桩把开关读成「这一条请求的查询串」，
   而请求是 `/api/v1/admin/boards`（开关只在**页面** URL 上）—— 两档图字节数完全相同就是它的症状。
   改成读 `location.search` 之后空态/错误态都出来了（`boards-empty` 与 `boards-error` 现在字节数不同）。
2. **`-Query 'asAdmin=0'` 做不出无权限态**：`URLSearchParams.get` 只认**第一个** `asAdmin`，
   而脚本总是先拼 `asAdmin=1`。所以加了一个 `-NoAdmin` 开关（不拼那一段），两档图字节数因此真的不同了。
3. `web/scripts/shoot-admin.ps1` 是 **UTF-16LE + BOM**（PS 5.1 默认按 ANSI 读没有 BOM 的文件，中文注释会炸成乱码）。
   我用工具改它时被写成了 UTF-8，脚本立刻报 `Missing expression` —— 已按原编码写回，改它的人注意这一点。

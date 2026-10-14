# 进度 · W-D1（任务：交接单 §4.C 里还欠的后台端点）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **C1 / C2 / C3 / C6**。
> 基线 master = `3c59b5f`（两端全绿：web 28 文件/146 用例，forum 34 包）。
> 作用域（只碰这些）：`forum/internal/{auth,user,forum,site}/**`、`forum/internal/app/**`（接线）、
> `forum/migrations/postgres/**`（新建迁移对）、本文件。**不碰** `web/**`、
> `forum/internal/{media,notify,appeal,reward,...}/**`。
> 收工命令（**不跑 `pnpm check`**）：`cd web && pnpm typecheck && pnpm lint && npx vitest run`；
> 后端用 `$env:GOPATH/GOMODCACHE/GOCACHE + GOTOOLCHAIN=local + .tools/go/bin/go.exe`。
> 出图端口：**5221**（别人用 5199/5202/5210/5212/5214）。收工按 PID 关掉自己起的进程。

## 契约（前端/设计稿已经在用的那份就是真源）

来源：`界面施工-后端需求变动.md` §5.1 / §5.3 / §5.8 / §5.10 / §5.13，
字段名参照 `web/src/devroom/pages/15-admin/mock/{core,users}.ts` 的形状，
**但一律以 `forum/internal/**` 的 DTO 为准**（交接单 §5 陷阱 1）。

| # | 端点 | 权限 | 说明 |
|---|---|---|---|
| C1 | `GET /api/v1/admin/users` | `user.ban` | `?q=&status=&activated=&email_verified=&role=&limit=&cursor=` |
| C1 | `GET /api/v1/admin/users/{id}` | `user.ban` | 含 `sanctions[]`/`user_permissions[]`/`user_titles[]` |
| C2 | `GET /api/v1/admin/boards` | `board.manage` | 含归档分区（公开列表只有 active） |
| C2 | `POST /api/v1/admin/boards` | `board.manage` | slug 不可改（改 slug 等于废掉所有外链） |
| C2 | `PATCH /api/v1/admin/boards/{id}` | `board.manage` | 只改给了的字段 |
| C2 | `POST /api/v1/admin/boards/reorder` | `board.manage` | body `{ids:[]}`，全量顺序 |
| C2 | `GET /api/v1/admin/boards/{id}/acl` | `board.manage` | `[{role_id,can_post,can_reply,deny_post,deny_reply}]` |
| C2 | `PUT /api/v1/admin/boards/{id}/acl` | `board.manage` | **全量替换**（逐格 PATCH 会暴露「禁止优先」的中间态） |
| C2 | `GET/POST/DELETE /api/v1/admin/boards/{id}/moderators[/{userId}]` | `board.manage` | 版主任免，带 `expires_at` |
| C3 | `GET /api/v1/admin/diagnostics` | `site.setting` | **debug 关闭时 404 common.not_found**，不是空 200 |
| C6 | `POST /api/v1/admin/users/batch` | `user.ban` | `{ids,action,role_id?,reason?}`，**逐条返回成功失败** |

## 步骤

- [x] 第 1 步：进度文件骨架 + 契约锁定
  - 证据：`git rev-parse HEAD` = `3c59b5f`（写骨架时）；`git status --porcelain` 里当时只有本文件。
  - 下一步：写 C1（`forum/internal/auth/admin_users.go` + `handler.go` 的路由 + 会红用例）。
  - 阻塞：无

- [x] 第 2 步：C1 —— `GET /admin/users`（筛选 + 游标）与 `GET /admin/users/{id}`（三张关联表）
  - 做了什么：新增 `forum/internal/auth/admin_users.go`（service + DTO + 游标）、
    `forum/internal/auth/pgsql/admin_users.go`（四条原生 SQL）、`forum/internal/auth/admin_users_test.go`；
    `handler.go` 的 `/admin` 组加两条路由与两个 handler（权限点沿用 `user.ban`）。
  - 证据（**先红后绿**）：路由还没挂时
    `go test ./internal/auth/ -count=1 -run TestAdminUsersListGuards -v` →
    `admin_users_test.go:83: 游客必须是 401，实际 404：404 page not found`（FAIL）；
    挂上路由后同一命令 `--- PASS`；整包 `go test ./internal/auth/... -count=1` → `ok forum/internal/auth 48.8s` + `TEST_EXIT=0`。
    六条用例：游客 401 / 无 user.ban 403（断言错误码 `common.forbidden`）、service 层守卫、
    八组筛选（status / role / email_verified / activated / q 三列 ILIKE / 组合）+ 非法 status 400、
    游标翻页无漏无重 + 伪造游标 400、详情三条处罚两条追加一条头衔、内容计数 1/1 与 0/0、
    HTTP 包络 `{data,next_cursor}` + 14 个字段名逐条存在。
  - 两个踩到的坑（写下来）：① 第一页游标必须换成 MaxInt64 哨兵 —— 直接用 0 会让 `u.id < 0` 恒假，
    整表**静默**返回空列表（这一条差点被我当成「筛选写错了」查半天）；
    ② `topics.last_reply_at` 在迁移里是 NOT NULL **无 DEFAULT**（`now()` 只在 ent 侧），
    原生 SQL 造数据必须显式给值。
  - 下一步：C6 —— `POST /admin/users/batch`。
  - 阻塞：无

- [x] 第 3 步：C6 —— `POST /admin/users/batch`（逐条返回成功失败）
  - 做了什么：新增 `forum/internal/auth/admin_batch.go`（`BatchUsers` + `BatchItemResult`/`BatchUsersResult`）、
    `admin_batch_test.go`；`handler.go` 加 `POST /users/batch` 与 `adminBatchUsers`。
    四个动作 `ban/unban/activate/set_role` **全部转发到单条端点的同一套实现**
    （`BanUser`/`ActivateUser`/`SetUserRole`），不复制语义 —— 所以 `guardLastSuper`、
    `role.assign` 的权限判定、幂等性与审计在批量路径上逐字相同。
  - 证据（**先红后绿**）：路由没挂时 `go test ./internal/auth/ -count=1 -run TestBatchUsers -v` →
    `admin_batch_test.go:87: 游客必须是 401，实际 404` + `HTTPEnvelope ... 实际 404`；挂上后八条全 PASS，
    整包 `go test ./internal/auth/... -count=1` → `ok forum/internal/auth 54.6s` + `TEST_EXIT=0`。
    八条用例：401/403 守卫、五个包级 400（空 ids / 非法 action / 无 action / 超 100 / 无身份）、
    HTTP 包络 `{total,succeeded,failed,items[{id,ok,error{code,message}}]}` + 落库断言、
    **4 条里成功 2 失败 2 且顺序与请求一致**（不存在 + 非 uuid 各一条，失败不拖垮后面的）、
    最后一名超管不能被批量停用（错误码 `admin.last_super`）、
    `set_role` 对只有 `user.ban` 的 admin 逐条 403 而换成超管就成功、批量激活幂等 + 两行审计、unban 反向。
  - 一个刻意的取舍（写下来免得被当 bug）：**缺 `role_id` 是逐条失败而不是整批 400**。
    理由：同一批里可能混着别的动作，整批 400 会把本来能做的也挡掉；而「这一条不成立」
    正是 items[] 要表达的东西。整批 400 只留给「这次请求本身不成立」的四种（空/超限/非法动作/无身份）。
  - 下一步：C3 —— `GET /admin/diagnostics`。
  - 阻塞：无

- [x] 第 4 步：C3 —— `GET /admin/diagnostics`（debug 关闭给明确错误码）
  - 做了什么：新增 `forum/internal/auth/admin_diagnostics.go`（`AdminDiagnostics` + 四条检查 +
    DTO）与 `admin_diagnostics_test.go`；`handler.go` 加 `a.GET("/diagnostics", svc.Perm(authz.PermSiteSetting), ...)`、
    `adminDiagnostics`；`service.go` 加 `diag DiagnosticsInfo` 字段 + `Deps.Diagnostics`；
    `app/http.go` 注入 `{Version, StartedAt, Readonly:true}`（`SetDiagnostics`）。
    `schema_check.go` 的 `CheckPermissions` 拆出 `checkPermissionSet(ctx, strict)`（面板用 strict=false）。
  - 证据（**先红后绿**）：路由没挂时 `go test ./internal/auth/ -count=1 -run TestAdminDiagnostics -v` 全 404 红；
    挂上后六条全 PASS；`go test ./internal/auth/... ./internal/app/ -count=1` →
    `ok forum/internal/auth 87.2s` + `ok forum/internal/app 20.0s` + `TEST_EXIT=0`。
    六条用例：游客 401 / 无 `site.setting` 403（断言码）、**debug 关闭 → 404 `common.not_found`**（两层：HTTP 与 service）、
    debug 打开 → 200 且四条检查的形状（status 与 ok 两个投影必须一致、红的那条必须带 detail、汇总 failed 与逐条相符）、
    没注入构建信息时版本那条**不报红**、**删掉一个权限点后「权限点集合一致性」真的变红**
    （先断言删之前是绿的 —— 不先绿一次，红可能是别的原因）。
  - 取舍：版本那条**只查「迁移过没有 / dirty」**，不比二进制里的最高迁移号 ——
    那个数字在 `migrations` 包，import 它会把认证域和部署动作绑在一起；严格比对在 `db.EnsureVersion`（拒绝启动）里。
  - 下一步：C2a —— `GET/POST /admin/boards` + `PATCH /admin/boards/{id}` + `POST /admin/boards/reorder`
    （`forum/internal/forum/admin_boards.go` + `pgsql/admin_boards.go`；权限 `board.manage`）。
  - 阻塞：无

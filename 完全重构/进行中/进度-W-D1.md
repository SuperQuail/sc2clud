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
  - 下一步：C6 —— `POST /admin/users/batch`（`forum/internal/auth/admin_batch.go`，逐条调
    `BanUser` / `ActivateUser` / `SetUserRole`，每条自己的事务 + 自己的审计；一个事务全回滚是不许的）。
  - 阻塞：无

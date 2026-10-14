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
  - 下一步：C2 —— `/admin/boards*` 整组。
  - 阻塞：无

- [x] 第 5 步：C2 —— `/admin/boards*` 整组（列表 / 建 / 改 / 重排 / ACL 全量替换 / 版主任免）
  - 做了什么：
    - 迁移 **0050_boards_public_id**：boards 补 `public_id uuid NOT NULL DEFAULT gen_random_uuid()` + `uq_boards_public_id`。
      **为什么必须补**：`httpx.ValidPathIDs("id","sid")` 是挂在 forum 域上的**组**中间件，而 boards 是全站唯一
      只有自增主键的业务表 —— 不补这一列，`/admin/boards/{id}` 只能用可改的 slug（改 slug = 废掉所有外链），
      或用自增 id（违反「自增 id 不出 API」）。
    - 迁移 **0051_board_moderator_grown**：`board_moderators` 加 `grown_at`；`UNIQUE (board_id,user_id)` 换成
      **部分**唯一索引 `WHERE grown_at IS NULL`（卸任 = 置 `grown_at`，不删行；重复任命因此成为可能）；
      并补 `idx_board_moderators_board (board_id)`。
      **连带改了三处判定 SQL**（`auth/pgsql/queries.go` 的 ResolveSessionSQL 与 LoadActorSQL、
      `forum/pgsql/access.go` 的 ACLRowFor 的 EXISTS）—— 漏一处就是权限泄漏。
    - 新增 `forum/internal/forum/admin_boards.go`（DTO + 读 + requireBoardManage）、`admin_boards_write.go`
      （建/改/重排）、`admin_boards_acl.go`（ACL 全量替换 + 版主任免）、`handler_admin_boards.go`（9 条 handler）、
      `pgsql/admin_boards.go` + `pgsql/admin_boards_write.go`（全部 SQL）、`admin_boards_test.go`（7 条用例）。
    - 改动 `handler.go`（9 条路由，`{id}` 走 ValidPathIDs）、`errors.go`（两条版主错误码）、
      `deps.go`（InvalidateUser 钩子）、`pgsql/query.go`（QueryRow 小工具）、
      `app/modules.go`（把钩子接到 `m.Auth.InvalidateUser`）、`auth/fixture_test.go`（夹具补 grown_at 与两条索引）。
  - 证据（**先红后绿**）：路由与 service 方法都不存在时该包连编译都过不去（「端点不存在」的直接证据）。
    写完后单条跑：`go test ./internal/forum/ -count=1 -run TestAdminBoards` 一族 → 7 条全 PASS；
    整包 `ok forum/internal/forum 57.8s`、`ok forum/internal/forum/pgsql 9.0s`、
    `ok forum/internal/app 13.6s`、`ok forum/internal/auth 60.2s`（最后一条见收尾一节的重跑）。
    七条用例：9 条路由的游客/无权限守卫（断言码）、列表**含归档分区**+position+版主名单、
    建（slug 五组非法值 + 撞 slug 400 + 默认不启用 ACL + 审计一行）/ 改（只改给了的字段、空 body 400、
    不存在与非 uuid 都 404）、重排（少给/重复/非 uuid/不存在四种 400 + 正序落库 + position 跟着走 + 审计）、
    ACL **全量替换**（少一行就真删掉、审计 before/after 按 role_key、同格 can+deny 400、重复角色 400、
    不存在的角色 400、失败不动库、空矩阵 = 清空）、版主任免闭环（过去任期 400、用户不存在 404、
    幂等 upsert 不新增行、卸任留历史行 + 名单里消失 + 再免 404 + **免了再任命能成功**）、
    权限快照失效钩子被调两次。
  - 三个踩到的坑（都是机器检查抓到的，写下来）：
    ① **删掉 UNIQUE (board_id,user_id) 会让启动自检拒绝启动**：它是 board_id 外键唯一一条**非部分**索引，
       部分索引（`WHERE grown_at IS NULL`）不算（RI 查找用不了带谓词的索引）。原文：
       `外键 board_moderators.fk_board_moderators_board 上没有可用索引`。修法：迁移里补 idx_board_moderators_board。
    ② **auth 的测试夹具是 `client.Schema.Create` 建的库**，没有 grown_at 这一列 → 整个 auth 包的会话用例
       全报 `字段 m.grown_at 不存在 (SQLSTATE 42703)`。夹具本来就写着「与迁移的差异必须在建表后补上」，按它补。
    ③ **迁移号被三个工作包同时占**：先用 0023/0024 → 撞 0023_moderator_to_creator；改 0025/0026 → 又撞
       0025_topics_hot 与 0026_issue_kinds（`duplicate migration file` 让 app 的 e2e 整包红）；最终用
       **0050/0051**（远离 002x 的争用区）。**迁移号需要 Lead 统一分配。**
  - 下一步：无（本工作包 C1/C2/C3/C6 全部落地）。接手人接前端时看本文件开头那节的端点表。
  - 阻塞：无（原先挡住验证的 `cursor.go` 在途改动已由那份工作包自己修好）。
---

## 收尾（W-D1，2026-10-14）

**任务完成**：交接单 §4.C 的 C1 / C2 / C3 / C6 四条全部落地并提交，每条一个 commit（都只 add 我改的文件）。

| commit | 内容 |
|---|---|
| `7710d26` | C1 `GET /admin/users` + `GET /admin/users/{id}`（筛选三根状态轴 + 游标 + 三张关联表） |
| `3b6e616` | C6 `POST /admin/users/batch`（逐条成功失败） |
| `43092e6` | C3 `GET /admin/diagnostics`（site.setting + debug 双门控） |
| `6f741a2` | C2 `/admin/boards*` 整组 + 迁移 0025/0026（后改号 0050/0051） |
| 本 commit | C2 收尾：迁移补 FK 索引、夹具补 grown_at、迁移改号 0050/0051、ACL 全量替换的边界 |

**收工验证（命令 + 结尾输出）**：

- `gofmt -l .`（forum/）→ 列出的 7 个文件**全是别人在途的**（`dto.go`、`hot_sort_test.go`、
  `board_levels_test.go`、`issue_filter_test.go`、`path_order_test.go`、`revision_test.go`、`pgsql/boards.go`）；
  对我改的 26 个文件单独跑 `gofmt -l <files>` → **无输出，exit 0**；
- `go vet ./...` → `VET_EXIT=0`（全仓）；
- `go test ./internal/auth/... ./internal/forum/... ./internal/app/ ./internal/user/ ./internal/site/ -count=1` →
  `ok forum/internal/auth 82.0s`、`ok forum/internal/forum/pgsql 14.9s`、`ok forum/internal/app 20.0s`、
  `ok forum/internal/user 18.5s`、`ok forum/internal/site 34.7s`；
  **`internal/forum` 整包是 FAIL，但那两条红的用例不是我的**：
  `TestBoardReplyLevelIsSeparateFromPostLevel`（别人的 0027_board_reply_level / E1 回帖门槛）与
  `TestRevisionRequestedKeepsOnlyAuthorAndShowsApprovedVersion`（别人的 0028_topic_revisions / L6 第四态）。
  我这一包新增的 7 条用例在同一轮里全 PASS，且单跑 `-run TestAdminBoards\|TestCreateAndUpdateBoard\|TestReorderBoards\|TestBoardACL\|TestBoardModerator`
  → `ok forum/internal/forum 15.5s`。

**没做的 / 留给 Lead 的**：

1. **迁移号需要统一分配**。这一轮里 0023 / 0025 / 0026 / 0027 / 0028 / 0040 都被不同工作包同时占了，
   `duplicate migration file` 会让 golang-migrate 直接拒绝启动（app 的 e2e 整包红过一次）。我最终用 0050/0051。
2. C2 的**封面**只做了 `cover_hash` 字段的读写（PATCH 里可传），**没有做图片上传端点**（§5.10 提到
   `POST /admin/boards/{id}/cover` 走图片通道）。理由：`media` 域不在我的写作用域里，而复用它的通道
   需要改 media 的 handler。前端现在可以先用已有的图片上传通道拿到 hash 再 PATCH 进来。
3. 权限点：C2 的**版主任免**沿用了 `board.manage`（§5.10 只写了「权限点 board.manage」）。
   若产品要区分「管分区结构」与「任免版主」，那是一个新的权限点（要加常量 + 迁移 + 24 个点的自检跟着动）。
4. 我在 `auth` 的测试夹具里补了 `grown_at` 与两条索引（迁移 0051 的形状）。**这是夹具与迁移的第二处手工同步**
   （前两处是 uq_roles_super / uq_email_tokens_live）—— 长期看应该把 `grown_at` 加进 ent schema 并重新生成代码，
   那件事需要能跑 ent codegen 的人做。

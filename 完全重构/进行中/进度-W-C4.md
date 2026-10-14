# 进度 · W-C4（C4 + C5 申诉闭环）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **C4 + C5**。
> 作用域（只碰这些）：`forum/internal/appeal/**`（新建）、`forum/migrations/postgres/**`（新建一对 .up/.down）、
> `forum/internal/app/**`（接线）、`forum/internal/testkit/**`（新建，测试替身）、`forum/internal/notify/service.go`（加一个方法）、
> `forum/internal/user/lookup.go`（Brief 加一列 RoleID）、`web/src/lib/api/social.ts`（只加函数）、本文件。
> **不碰** `forum/internal/forum/**`、`web/src/routes/**`、`web/src/app/**`。
> **接手规则**：读完本文件 + `git log --oneline -12` 就能继续，不需要任何对话记录。
> 收工命令：`cd web && pnpm typecheck && pnpm lint && npx vitest run`（**不跑 pnpm check**）；
> 后端用 `$env:GOPATH/GOMODCACHE/GOCACHE + GOTOOLCHAIN=local + .tools/go/bin/go.exe`。
> 出图端口：**5214**（别的包用 5202/5210/5212，别撞）。收工按 PID 关掉自己起的进程。

## 契约（前端已经在发的那份就是真源）

`web/src/routes/appeal.tsx` 已经在发 **`POST /api/v1/appeals`**，体是
`{ type, username, email, ref?, title, details, contact?, captcha? }`，期望 `202 { no, eta? }`。
类型值域 `ban | review_reject | report_result | other`（照 DevRoom `17-appeal/data.ts`）。

| 端点 | 登录 | 说明 |
|---|---|---|
| `POST /api/v1/appeals` | **免登录** | 202 `{no, eta, status, created}`；限流 3 条/24h/身份/类 + 20 次/h/IP |
| `POST /api/v1/appeals/lookup` | **免登录** | 单号 + 注册邮箱，两条都对上才给看（否则同一个 404） |
| `GET /api/v1/me/appeals` | 登录 | `{data:[Appeal], next_cursor}`；按 user_id 过滤 |
| `GET /api/v1/admin/appeals` | `report.handle` | `?status=&type=&q=&limit=&cursor=` |
| `PATCH /api/v1/admin/appeals` | `report.handle` | 体里带 `no`；`overturned` 额外要 `post.review` |
| `POST /api/v1/topics/{id}/review/appeal` | 登录 + **仅作者** | 201（新建）/ 200（幂等重放），C5 |

**验证码字段名**：前端发 `captcha`（答案）；本域**同时收 `captcha_id`**（`ProductCaptcha` 有 `onChallenge` 回调，
但 `routes/appeal.tsx` 还没接上 → 见「阻塞」第 2 条）。只发答案时后端按「这道题不存在」判 400 `auth.captcha_wrong`。

## 步骤

- [x] 第 1 步：进度文件骨架 + 契约锁定
  - 证据：`git log --oneline -1`；`git status --porcelain` 里当时只有本文件。
  - 下一步：写迁移 0022 + appeal 域。
  - 阻塞：见下。

- [x] 第 2 步：迁移 0022（appeals 表）+ `forum/internal/appeal/**`（types/errors/dto/deps/service/handler/pgsql/tx）
  - 证据：`go build ./internal/...` EXIT=0；`go vet ./internal/appeal/...` EXIT=0；`go test ./internal/appeal/ -count=1` → `ok`（`TestCreateGuards` 0.09s，不需要数据库）。
  - 关键决定（**写下来免得被当成 bug 改掉**）：状态只有三值 `pending/replied/closed`，设计稿第四态「已驳回」
    = `decision=upheld`（挤进 status 会答不了「驳回之后还能不能补充材料」）；改判必须**真的放行那篇帖子**
    （forum.ReviewTopic），否则就是「端点声称做到的事没做到」；C5 幂等押在部分唯一索引
    `uq_appeals_topic_pending` 上（并发重放时先查后插会插两条）。
  - 下一步：把域接进 app（modules/http）+ e2e。
  - 阻塞：无

- [x] 第 3 步：接线（`app/appeal.go` 六个适配器 + `registerAppeal` + `limitIP`）+ e2e 用例
  - 证据：`go test ./internal/app/... -count=1` → `ok forum/internal/app 12.7s`（含既有的 `TestEndToEndMainChain`）。
    `TestAppealEndToEnd` 逐条断言：未登录 201 + 库里 `identity_verified=true`；答错验证码 400 `auth.captcha_wrong`；
    不带验证码 400 `auth.captcha_required`；免登录提交 `review_reject` 400；单号+邮箱能查、邮箱错 404；
    普通用户看队列 403；空答复 400；处理回 200 `status=closed`；重放 409；已处理的不在 pending 队列；
    提交人（未登录 + 已登录两条路）都看得到答复；C5 未登录 401 / 非作者 403 / 作者 201 / 重放 200 同单号 /
    库里只有一条；改判后帖子的 `review_state` 真的变 `approved`、`review_events` 里恰好一行 `manual`。
  - **踩过的两个坑（写下来）**：
    ① 本包的 e2e 共用一个库，我第一版把发信账号也叫 `log-dev`（与 `e2e_test.go` 同名）→
       `TestAppealEndToEnd` 字母序在前，把主链路的前置撞成「账号名已存在」；改名 + 全部前置带每轮唯一后缀。
    ② 想给本用例独占一个 schema，但 golang-migrate 的 pgx/v5 driver **不认 DSN 里的 `options=-c search_path=`**
       （报「未认可的配置参数 "+search_path"」）→ 放弃 schema 隔离，改成唯一名字。
  - 下一步：前端 `lib/api/social.ts` 加函数。
  - 阻塞：无

## 阻塞（要 Lead 动的）

1. **`web/src/app/router.tsx:55` 的 `appeal` 路由被注释掉**（`{ path: 'appeal', element: <AppealPage /> }`）—— 整页不可达。
   这一行在 **Lead 的冻结文件**里（`router.tsx`），我不碰。端点已经通了，请取消注释；
   之前那句「后端端点不存在，整页隐藏」的理由**已经作废**（本次落地：POST /api/v1/appeals、/appeals/lookup、
   /me/appeals、GET+PATCH /admin/appeals、POST /topics/{id}/review/appeal）。

2. **`web/src/routes/appeal.tsx` 少发一个字段（要 Lead 或本页负责人改一行）**：
   `ProductCaptcha` 有 `onChallenge?: (id: string) => void`（`web/src/routes/login.tsx`），
   而 `routes/appeal.tsx` 只传了 `value/onChange` → `captcha_id` 永远为空 →
   后端按「这道题不存在」判 400 `auth.captcha_wrong`（文案会说「验证码不对，请重新输入」，用户会以为是自己看错了图）。
   改法：加一个 `const [captchaId, setCaptchaId] = useState('')`，`<ProductCaptcha value={captcha} onChange={setCaptcha} onChallenge={setCaptchaId} />`，
   提交体里加 `captcha_id: captchaId`。**这条不在我的写作用域（routes/**），所以留在这里给 Lead。**
   后端两侧都收（`captcha_id` 可缺但缺了就判错），所以修前端不需要改后端。

## 与本任务无关、但跑测试时撞见的两件事（**不是本次改动引入的**）

1. `go test ./internal/notify/pgsql/` 的 `TestListNotificationsPlanUsesInboxIndex` 在本机 **红**：
   `错误: 有缺陷的数组常量:"" (SQLSTATE 22P02)`（`EXPLAIN` 传 nil 数组参数；本机是 PostgreSQL 18.3）。
   我只往 `notify/service.go` 加了一个 `NotifySystem` 方法（新代码，不被那条用例覆盖）。
2. `go test ./internal/app/ -count=2`（同一套库连跑两遍）第二遍红：`root` / `alice` / `log-dev` 这些**写死的名字**
   在第二遍撞唯一键。单遍（`-count=1`）全绿 —— 这是既有 e2e 的可重复性问题，不在本次范围。

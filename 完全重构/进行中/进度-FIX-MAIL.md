# 进度 · FIX-MAIL（D26 —— 邮件发码器是假数据、完全无功能，不该进 dev/生产）

> 任务书：`完全重构/进行中/10-dev排查-缺陷清单.md` 第 0 节（同源要求）+ §1e 的 D26。
> 环境与协议：`完全重构/进行中/07-一次性完工交接单.md` §1/§2/§3。基线 master = `f121c63`。
> 出图端口：静态服务 **5301**、CDP **9341**（`web/scripts/serve-preview.ts` + `web/scripts/cdp-shot.ts`，收工按 PID 关）。
> 验证：**不跑 `pnpm check`**；跑 `pnpm typecheck && pnpm lint && npx vitest run`（后端 `gofmt -l .` + `go vet ./...` + 单包 `go test`）。
> 作用域：`web/src/devroom/pages/15-admin/screens/**`（发信账号那屏）、`web/src/routes/admin/**`、
> `web/src/lib/api/admin*.ts`、`forum/internal/mail/**`（读数/加接口）、`完全重构/进行中/进度-FIX-MAIL.md`。
> **不碰** Lead 专属：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`、`deploy/**`。

## 第 0 步：核清现状（D26 的「假数据」到底指什么）—— **证据先于结论**

- **表在**：`forum/migrations/postgres/0014_mail.up.sql` 建 `mail_accounts` / `mail_quota` / `mail_logs`；
  0018 把 `provider` 值域放开到 `resend | smtp | log`。`ent/schema/mail_account.go` 与 `ent/migrate/schema.go` 都在。
- **端点全在**：`forum/internal/mail/handler.go:32-37` 五条（`GET/POST /admin/mail/accounts`、
  `PATCH/DELETE /admin/mail/accounts/{id}`、`POST /admin/mail/accounts/{id}/test`），权限点 `mail.manage`；
  接线在 `forum/internal/app/http.go:119`。**发信链路也是真的**：`mail/tasks.go` 的 `mail:send` 任务 +
  `platform/mail` 的 resend/smtp/log 三个 provider + 模板渲染 + 额度账；
  `forum/internal/app/e2e_test.go` 的主链路是「注册 → 真投递 → 从 log provider 读 6 位码 → 激活」，**跑真库真队列**。
- **迁移带过来的账号**：`数据迁移审计.md:287-302` 明确写「老站 1 行，**密文没迁**（主密钥不同），要在后台重填 API key」；
  同文 `:1159` 记 `mail_accounts` 多一行 `dev-log` 是 **dev 种子**。
- **产品屏接的是真端点、不是 mock**：`web/src/routes/admin/mail.tsx` 调 `lib/api/admin.ts` 的四条真函数；
  而 `web/src/lib/api/admin.ts:280` 的 `createMailAccount` **一个调用方都没有**。
- **结论（D26 的真实形状）**：不是「假数据」，是**缺了唯一的写入口** ——
  (1) 屏上没有「新增账号」表单（后端 POST 在、前端函数在、**界面不在**）；
  (2) 已有账号**没有配/换凭据的入口**（`secret_configured=false` 的行看起来正常，其实发不出信）；
  (3) 房间版（DevRoom）用 `DEMO_MAIL` 三行演示数据、点了只回执 —— 与产品屏同源之后就只剩「按钮点了没反应」。
  旁证：`后端设计/d6-reward.md` §6.10（凭据只写不回读、name 不可改）、`论坛后端技术方案-v2.md` §8.2
  （「发信账号不写进配置文件、不写进环境变量…管理员在后台增删改」）、同文 `:613`（**一个账号都没有时不再拒绝启动**，
  「改为打一条 Warn + 后台首页显示提示」）—— 也就是说：**没有这个表单，生产上就一个账号都建不出来**，
  而注册会直接 503 `auth.mail_unavailable`（`d2-auth.md:2257` 的验收第 44 条）。

## 选路：**① 真做**（不是 ② 从 dev/生产去掉这屏）

| 判据 | 事实 |
|---|---|
| 后端是不是空壳？ | **不是**。表 / 端点 / provider / 任务 / e2e 全在，单包 13 条用例真库跑（`mail_test.go`） |
| 缺的是不是只有前端？ | **是**。缺「新增账号」与「配凭据」两块表单，API 客户端函数已有 |
| 去掉这屏会怎样？ | **回归**：老站迁来的账号要重填 API key（迁移审计 `:870` 明写「后台重填」），去掉就**没有别的入口** |
| 会不会让整站起不来？ | **不会**：邮件不可用只影响注册（503）与找回密码，其余功能照旧 —— 这正是既定决定 |

**所以第 ② 条的代价是「生产上永远发不出验证码」，而第 ① 条只需要补两块表单。**
假数据那部分另按规矩处理：房间里保留演示数据并逐字标注「房间演示：这里不发请求」；
产品屏只显示库里的真值，并在「一个可用账号都没有」时就地报警（第 3 步）。

- [x] 第 1 步：**新增账号**（D26 的「无法新增账户」）—— 先证明会红 → 改 View → 出图 → 宿主接线 → 房间同源
  - 做了什么：① 新 `screens/mail-new.tsx`：`NewAccountDialog`（账号名 / provider / 凭据 / 发件人 / 优先级 / 日额度 / reset_tz / 启用），
    必填三项与后端 `mail/dto.go` 的 `AccountInput` binding 对齐；provider 用 **Radio.Item 三选一**（三个值都摆出来，选错建完就改不了）；
    ② 新 `screens/mail-cred.tsx`：凭据字段按 provider 分三套（resend→api_key、smtp→host/port/username/password、
    log→不需要且说明只能配在 dev/测试）+ `credMissing` / `credPatch` 两个纯函数；
    ③ `screens/mail.tsx`：`ScreenHead` 加「新增账号」、右栏「新建账号」面板改成真按钮、三处 `data-testid`；
    ④ 宿主 `routes/admin/mail.tsx`：接 `createMailAccount`（原来零调用方）+ 回执说明「还没有凭据就发不出信」；
    ⑤ 房间 `15-admin/index.tsx` 的 `MailRoom` 补 `onCreate`（本地加一行 + 「房间演示：这里不发请求」回执）。
  - 证据：
    **先证明会红**（断言钉的是「凭据形状」这条最容易静默错的）：新 `screens/mail-cred.test.tsx` 5 条；
    把 `credPatch('resend')` 从 `{secret:{api_key}}` 改成 `{secret:{apiKey}}`（就是 provider.go 读不到的形状）→
    `FAIL … AssertionError: expected { secret: { apiKey: … } } to deeply equal { secret: { api_key: … } }` + `Tests 1 failed | 4 passed`；
    改回去 → `Tests 5 passed (5)`。
    **出图并看图**（DevRoom，1440×900）：`shots/fixmail/d26-room-1440.png`（首屏多出「+ 新增账号」；每行「换凭据 / 配凭据」按钮按
    `secret_configured` 换词；「已配密钥」格从 2 改成 1 并写明「启用且已配凭据的才算」）、`d26-room-new-resend.png`（api_key 一个字段）、
    `d26-room-new-smtp.png`（host/port/username/password 四个字段 + 「port 可空 = 587」）、`d26-room-new-log.png`（无字段，只有说明）；
    窄屏（CDP_SIZE=390,844，实测 500px 是 headless 最小窗宽）：`d26-room-390.png` / `d26-room-new-390.png` / `d26-room-new-log-390.png`。
    `pnpm typecheck`（我的文件 0 条）/ `pnpm lint`（0 条）/ `npx vitest run` **53 files / 264 passed**（含新 5 条）；
    `pnpm gate:size`「超限 2 个，登记 2 个」（都不是本包）/ `gate:ui` / `gate:tokens` / `gate:controls`（48 个控件）全绿。
  - 下一步：第 2 步做**换凭据**的产品侧接线与回执出图（`RotateSecretDialog` 已写好、房间已接，产品 `onSecret` 已接但还没出真回执图），
    然后第 3 步给后端补「按 provider 校验凭据形状」（resend 缺 api_key / smtp 缺 `options_json.host` → 400，而不是建完到投递才发现），
    最后第 4 步把「生产带不带这屏」写进 `上线步骤.md`。
  - 阻塞：无。**但两条红不是我的**（同一时刻别人在途，11-profile 那块）：
    `pnpm typecheck` 1 条 `src/devroom/pages/11-profile/sponsor-card.test.tsx(11,47): Cannot find module '@testing-library/user-event'`；
    `pnpm lint` 1 条 `CHANNEL_BYTES is defined but never used`（同一文件）。请 Lead 让那位收口。
    另：`web/shots/` 既没进 .gitignore 也没被跟踪，我的图按仓库既有做法留在本地、不进提交。
    另：`web/shots/` 既没进 .gitignore 也没被跟踪，我的图按仓库既有做法留在本地、不进提交。

- [x] 第 2 步：**换凭据**（D26 的「无法配置已有账户」）—— 产品页出真回执图 + 后端 HTTP 契约先红后绿
  - 做了什么：① 产品侧 `onSecret` 走 `updateMailAccount(id, {secret, options_json})`（第 1 步已接，本步补的是**真回执与出图**）；
    ② 出图桩 `preview/admin-fixtures.ts` 加 `?mailNoSecret=1`（读页面查询串，与既有的 `?empty=1` / `?fail=1` 同一套写法）——
    用来演「迁移过来的账号：密文置 NULL」那一态；③ `screens/mail.tsx` 的「一封都发不出去」告警里 `**…**` 改成 `<strong>`
    （图上真看得见星号，而这不是设计稿里的排版记号）；④ 新增后端 `forum/internal/mail/admin_http_test.go`。
  - 证据：
    **后端 HTTP 契约先红后绿**：`go test ./internal/mail/ -run TestAdminAccountCreateAndRotateOverHTTP -v`
    → 先把 `mail/dto.go` 的 `secret_configured` 标签改成 `secretConfigured`（前端读的就是这个键）→ `--- FAIL … 回执字段不对（前端读 id / secret_configured / secret_updated_at）`；
    改回去 → `--- PASS`。随后整包 `go test ./internal/mail/ -count=1` → `ok forum/internal/mail 16.562s`（含 W-C9 那条未跟踪的路径闸用例）。
    这条钉的是**前端真正依赖的三件事**：201 建号、回执里 `secret_configured=true` 且**不出现 secret 字段**、PATCH 换凭据后 `secret_updated_at` 变新。
    **产品页出图看图**（`admin.html?route=/admin/mail&asAdmin=1`，真壳真路由真容器 + 桩数据）：
    `shots/fixmail/d26-product-mail.png`（同一份 View：顶栏「管理后台」、左栏 12 项、右栏「+ 新增账号」）、
    `d26-product-new.png`（新增账号弹层在**产品页**里逐像素同形）、`d26-product-cred.png`（换凭据弹层：provider 固定 resend、只有一个 api_key、
    未填时「保存凭据」禁用 + 一行「resend 的 api_key 必填」）、`d26-product-no-secret.png`（两行都「未配置」时顶部出现告警
    「现在**一封邮件都发不出去**：没有一个『已启用 + 已配凭据』的账号…」，「已配密钥」格为 0）。
    `npx vitest run` 全量 **53 files / 264 passed**；`pnpm typecheck` / `pnpm lint` 我的文件 0 条。
  - 下一步：第 3 步（**已判定不做**，理由见下）与第 4 步 —— 把「生产带不带这屏」写进 `上线步骤.md`，并给 Lead 一份选路结论。
  - 阻塞：无。

### 第 3 步的取舍：**不做**「后端按 provider 校验凭据形状」，理由（不是省事，是判据）

原本打算给 `CreateAccount` / `UpdateAccount` 补一条（resend 缺 `api_key`、smtp 缺 `options_json.host` → 400）。
实测判据后**决定不做**：
1. **前端已经堵住了这个洞**：`credMissing()` 在提交前就要求 api_key / host / username+password 齐（三处出图可见按钮是禁用的）；
   而 `mail-cred.test.tsx` 把这条判定钉住了（第 1 步先红后绿）。再加一层是**重复校验**，两处迟早会漂。
2. **后端本来就是「配置错 → 显式失败」而不是静默**：`platform/mail/provider.go` 的 `provider()` 对 resend 缺 `api_key`、
   smtp 缺 `host` 都返回 `ErrPermanent`，`tasks.go` 把它写成 `mail_logs.status=failed` + `last_error`，界面上是红字「失败 + 原因」——
   这是**管理员能看见、能修**的失败（`mail.accounts.go` 的 `SendTest` 另有同步校验：停用/归档/凭据解不开都会当场报错）。
3. **加了反而更糟**：迁移过来的老账号**就是没凭据**（密文置 NULL，迁移审计 `:287-302`），收紧写路径会让它们连
   「先改个额度」都做不到 —— 上一句「重填 API key 是运维动作」是既定的恢复路径，不该被写路径挡住。

若日后要加，判据是这条**而不是「更安全」**：需要能说出「哪一种账号是合法的但会在投递时才失败」。现在说不出来。

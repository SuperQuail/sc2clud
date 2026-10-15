# 进度 · FIX-PERM（D25 / D28 / D29 —— AI 审核预览与图片、默认权限树、手动激活开关）

> 任务书：`完全重构/进行中/10-dev排查-缺陷清单.md` 第 0 节（同源要求）与 §1e 的 D25 / D28 / D29。
> 环境与协议：`完全重构/进行中/07-一次性完工交接单.md` §1/§2/§3。基线：master = `f121c63`。
> 验证命令：**不跑 `pnpm check`**；前端 `pnpm typecheck && pnpm lint && npx vitest run`，
> 后端 `gofmt -l .` + `go vet ./...` + 单包 `go test -count=1`（Go 走 `.tools/go/bin/go.exe`，见交接单 §1）。
> 作用域：`web/src/devroom/pages/15-admin/screens/**`、`web/src/routes/admin/**`、`web/src/lib/api/admin*.ts`、
> `forum/internal/aireview/**`、`forum/internal/site/**`、`forum/internal/auth/**`、`forum/migrations/postgres/**`（0052+ 如需）、本文件。
> **不碰** Lead 专属：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`、`deploy/**`。

- [x] 第 1 步：D25② 实测「图片发不发」—— **结论：不发**（上行 payload 只有 system/user 两段纯文本）
  - 做了什么：`forum/internal/aireview/aireview_test.go` 新增 `TestOutboundPayloadHasNoImageField`（用带 `![封面](/img/<hash>)` 的 1 楼正文走一次真判定，断言上行两段里没有 `image_url`/`data:image`，并把 user 文本**逐字**钉成 `标题：<t>\n\n正文：\n<body>`）。顺带实测出**第二个真 bug**：模型按 schema 省略非必填的 `categories` 时 `ai.parse` 返回 nil → 写 `review_events.categories`（`NOT NULL DEFAULT '{}'`，0020:48）撞 23502，判定落不了库还反复重试。修两处：`platform/ai/ai.go` 的 `parse` 让 Categories 永不为 nil；`aireview/service.go` 在**唯一写库口**再兜一次（外呼口是注入点，假实现也得被兜住）。
  - 证据：
    ① 先证明会红：`go test -count=1 -run TestOutboundPayloadHasNoImageField ./internal/aireview/` → 实际红在「23502 categories」上（正是那条 nil bug；把 categories 修好后同一断言转绿），说明这条用例真的在跑真库真判定；
    ② `go test -count=1 ./internal/aireview/ ./internal/platform/ai/` → `ok forum/internal/aireview 11.541s` / `ok forum/internal/platform/ai 1.347s`（整包跑，不 -run 过滤）；
    ③ 代码侧同源证据：`aireview/sql.go` 的 `sqlSubject` 只取 `topics.title` + `posts(floor=1).content_md`，**不 JOIN `topic_images`**；`platform/ai/ai.go` 的 `Judge` 只组 `SystemMessage(prompt)` + `UserMessage(text)` 两条消息，没有任何多模态字段。**图片唯一的痕迹是正文里的 Markdown 字面量**（`![封面](/img/<hash>)`），模型看不到图。
  - 下一步：D25① 审核屏就地预览被审内容（后端 `reviewQueueColumns` 加 1 楼 `content_md` 全文 + 待审版本 `rv.pending_md`，DTO 出 `body_md`；`screens/review.tsx` 右栏改渲染全文与图片 Markdown）；然后 D29（站点开关联动两条路径）、D28（`resource.publish` 漏配 + 对照表）。
  - 阻塞：无

- [x] 第 2 步：D25① 审核屏就地预览被审内容（正文全文 + 作者 + 来源；图片以 Markdown 原文可见）
  - 做了什么：**后端** `reviewQueueColumns` 加一列 `COALESCE(rv.pending_md, p.content_md, '')`（FROM 里 LEFT JOIN posts floor=1），
    `ReviewQueueRow.BodyMD` → DTO 的 `body_md`/`body_truncated`（换行统一 LF，超过发帖上限 `MaxTopicContent` 才截断并**标记**）；
    **前端** `screens/review.tsx` 右栏把原来那块 200 字摘要换成 `<pre data-testid=review-preview-body>` 的正文全文 + 字数/截断提示，
    `lib/api/admin-types.ts` 的类型跟上，`mock/fixtures.ts` 的三条演示数据补上 `body_md`（其中一条带图片、一条演示截断）。
  - 证据：
    ① **先红**：`go test -count=1 -run 'TestReviewQueueCarriesBodyForPreview' ./internal/forum/` 在旧 SQL 下红在
    `预览正文应当是 1 楼全文：得到 200 字，原文 1320 字`（行的就是 clipExcerpt 的 varchar(200)）；
    ② 绿：`go test -count=1 -run 'TestReviewQueue' ./internal/forum/` → `ok`（3 条新用例：全文 / 草稿档取待审版本 / 超上限必标记）；
    ③ 前端：`npx vitest run src/devroom/pages/15-admin/screens/review.test.tsx` → `6 passed`（新增 2 条：正文全文含图片 Markdown、截断要说出来），
    全量 `npx vitest run` → `56 files / 277 tests passed`；
    ④ 图：`shots/fixperm/d25-review-preview.png`（1440，右栏「正文全文 · 278 字」+ `![第三章新场景](/img/0123…)` 原文可见）、
    `d25-review-preview-390.png`（窄屏同源同一块）、`d25-review-default.png`/`d25-review-selected.png`。
  - 下一步：D29（站点开关联动注册/回执/重发三条路 + 管理端唯一的激活入口 + 注册页「等管理员激活」态）、D28（补 `resource.publish` + 对照表）。
  - 阻塞：无

- [x] 第 3 步：D25② 的结论落纸 + D29 手动激活开关（后端三条路联动 + 管理端入口 + 注册页态）+ 出图
  - 做了什么：**D25②** 结论写进 `10-dev排查-缺陷清单.md` §1e（**发/不发** 落「不发」）。
    **D29**：`auth.Deps` 加 `Settings` 端口（`site.Service` 填）→ 新增 `Service.autoActivate(ctx)`，
    真源 = 站点设置 `auth.registration.auto_activate`（`on`/`off`，空串才回落 `config.Auth.AutoActivateOn()`），
    三个读者全改用它（注册 `account.go`、`/me` 回执、重发 `email.go`）；
    前端 `lib/api/auth.ts` 的 register 回执补 `auto_activate`（后端本来就在发，前端原先丢掉了），`routes/register.tsx` 据此分支到「等管理员激活」态；
    管理端唯一的激活入口：`lib/api/admin.ts` 加 `activateUser`（走 `POST /admin/users/batch {action:'activate'}`，只写 `activated_at`）、
    `screens/users.tsx` 在「危险动作」面板给未激活账号加「激活账号」（复用 ConfirmDialog）、`routes/admin/users.tsx` 与房间宿主各接一条。
  - 证据：
    ① **先红**：把 `autoActivate` 换回「只认配置」再跑
    `go test -count=1 -run 'TestSiteSetting|TestAdminActivationWorksWhileSettingOff' ./internal/auth/` →
    `注册回执里的 auto_activate 仍是 true` / `关掉时重发应当被拒，实际 <nil>` / `手工激活把开关改掉了` 三条红；
    ② 绿：`go test -count=1 ./internal/auth/` → `ok`（整包，56s）；
    ③ 两条既有用例跟着改成**按真源**关开关（`TestRegisterManualModeSendsNoMail` / `TestResendDisabledInManualMode` 原来只改 cfg
    —— 那正是 D29 要修的行为），改完仍绿；
    ④ 前端：`users.test.tsx` 2 条（未激活有「激活账号」且点了走 `onActivate`、已激活没有那颗按钮）、全量 277 passed；`pnpm typecheck` 绿、`pnpm lint` 0 error；
    ⑤ 图：`shots/fixperm/d29-users-tall-selected.png`（选中「工蜂」待激活 → 右栏「危险动作」里出现「激活账号」）、
    `d29-users-390-row.png`（窄屏，待激活那一列可见）、`d29-users-default.png`。
    ⑥ 站点开关那一屏（D29 的落点）`mock/system.ts` 的键名与 label/hint 改成与 `site.SettingSpecs()` 逐字一致
    （旧键 `registration.require_activation` 删掉）。
  - 下一步：D28 的 0052 迁移与对照表（下一步）、然后收尾（`gofmt -l .` + `go vet ./...` + 全量前端三连）。
  - 阻塞：无

- [x] 第 4 步：D28 逐条核默认值与界面映射 —— 补 `resource.publish` + 一张对照表 + 一条会红的看门用例
  - 做了什么：`forum/migrations/postgres/0052_admin_resource_publish.{up,down}.sql`（**新迁移**，不改 0017：
    golang-migrate 只跑没跑过的版本，改老迁移对已迁移实例等于没改；0052 只补一个点、`WHERE NOT EXISTS` 幂等、不动后台改过的其他勾）；
    `forum/internal/app/role_permissions_test.go`（跑真迁移后查 `role_permissions`，与拍板 §1.2/§1.3 的矩阵逐点严格相等，
    多一个点也报）；对照表落 `完全重构/进行中/D28-默认权限矩阵对照表.md`（应该是什么 / 原来是什么 / admin 与 superadmin 的分界 / 界面映射 / 验收）。
  - 证据：
    ① **先红**：把 `0052_admin_resource_publish.up.sql` 改名再跑
    `go test -count=1 -run TestMigratedRolePermissionMatrixMatchesSpec ./internal/app/` →
    `角色 admin 的默认矩阵与拍板 §1.3 不一致：库里缺少: resource.publish`；
    ② 绿：同一条命令 → `ok forum/internal/app 7.450s`；
    ③ 差异只用一条就够（user / creator / superadmin 逐点相同，creator 的 `topic.lock`/`topic.move` 是 d2-auth §8.6 的明确取舍，写进对照表）。
  - 下一步：收尾验证（`gofmt -l .`、`go vet ./...`、`pnpm typecheck && pnpm lint && npx vitest run`）与进度/缺陷清单回写。
  - 阻塞：无

- [x] 第 5 步：收尾验证（整包后端 + 前端三连 + 格式化）
  - 做了什么：`0052` 补前置断言（权限点/角色不在表里时 `RAISE EXCEPTION` —— 光靠 JOIN 不到就是 0 行，
    迁移会「成功」而什么都没补，那正是这条要修的病）；`gofmt -w` 三个文件；删掉自己造的临时出图脚本与探针文件。
  - 证据：
    ① `go vet ./...` → 无输出；`gofmt -l .` → 无输出（改前点出三个文件，已格式化）；
    ② **全量后端**：`go test -count=1 ./...` → **36 个包全 ok**（`app 47.3s` / `auth 110.5s` / `forum 120.6s` /
    `aireview 30.9s` / `platform/ai 1.5s` / `site 62.7s`，无 FAIL）；
    ③ **前端三连**（不跑 `pnpm check`）：`pnpm typecheck` 绿、`pnpm lint` `0 errors, 21 warnings`（全是既有 warning）、
    `npx vitest run` → `56 files / 277 tests passed`；
    ④ 出图端口 **5288**（预览静态服务）收工按 PID 关：`Get-NetTCPConnection -LocalPort 5288 | OwningProcess` → 37780。
  - 下一步：本包三条（D25 / D28 / D29）已收口。留给 Lead 的：**dev 与 prod 都要跑一次 `forum migrate`**
    （0052 是数据迁移，不跑则 admin 仍缺 `resource.publish`）；站点开关的生效上限是 site 的 30 秒设置缓存
    （管理员改完，注册路径最多 30 秒后跟着变 —— 拍板 §12.2 允许 ≤30s 的读缓存）。
  - 阻塞：无（Lead 专属三文件与 `deploy/**` 未碰；D30 / D26 属别人的包，未动）

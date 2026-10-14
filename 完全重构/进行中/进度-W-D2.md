# 进度 · W-D2（后台 12 屏接线）

> 交接单 §4.D。开工基线与协议见 `07-一次性完工交接单.md`。
> 每完成一屏一个 commit，本文件在同一 commit 里更新（四行：做了什么 / 证据 / 下一步 / 阻塞）。

## 变更
- [x] **接线地基**：新建 `web/src/lib/api/admin.ts`（+ `admin-types.ts`）把实测的 /admin/* 端点的**真字段名**落成客户端；`routes/admin.tsx` 改用 `AdminShell`（面包屑 + 当前管理员卡 + 权限明细）、权限点改成**后端 authz 常量那唯一一套**并删掉「perms 为空就不拦」的放宽；新建 `routes/admin-screens.tsx` 放**每屏一个取数容器**；**users 屏改成 prop 驱动**并接上已实装的四个动作端点（改角色 / 封号 / 踢会话 / 发头衔）与 `/admin/roles`、`/admin/titles`。
  - 证据：`cd web && npx tsc --noEmit` → 无输出（0 错）；`npx vitest run` → `Test Files 28 passed (28) / Tests 147 passed (147)`；`pnpm lint` → 仅 2 个 error，都在**别人在途的** `web/.tmp-wfi-scan.cjs`（`no-require-imports`），我的文件只有既有的 react-refresh warning。字段名逐个对过：`/admin/roles` → `auth/service.go RoleItem`（`badge_color`/`perm_keys`/`user_count`）、`/admin/titles` → `title/types.go TitleDTO`（`archived_at` **不是** mock 里的 `archived` 布尔 + `holders`）、`banReq` → `auth/handler.go:141`（`action` 只有 ban|unban）。
  - 下一步：**review 屏**（`screens/review.tsx`）改成 props 驱动，容器加进 `routes/admin-screens.tsx`；端点 `GET /admin/topics?state=&board=&q=&limit=&cursor=`（→ `{data,next_cursor}`）与 `POST /admin/topics/{id}/review` **body 必须带 `expected_updated_at`**（队列项的 `updated_at`，不带就 400），字段照 `forum/review_queue.go ReviewQueueItemDTO`；`review_verdict` 取最近一条 `review_events` 的结论、**不能从 `review_state` 三态推**（交接单 C11）。
  - 阻塞：**这一屏的数据端点 `GET /admin/users` 还不存在**（交接单 C1，W-D1 在补：他的 `forum/internal/auth/admin_users.go` + `auth/pgsql/admin_users.go` 已在工作区、未跟踪）。没有它时宿主拿到 404，屏上如实显示「用户列表没能加载（HTTP 404）」——**没有拿示例数据兜底**。剩下的 `boards` / `diagnostics` 两屏同理（C2 / C3），已在 `routes/admin-screens.tsx` 的 `PENDING_SCREENS` 里写明缺哪条端点。
- [x] **review 屏**（`screens/review.tsx`）改成 prop 驱动 + 容器 `ReviewScreenContainer`，接 `GET /admin/topics`（游标入 key）与 `POST /admin/topics/{id}/review`。三处照后端纠正：① `review_state` 三值是 `pending|approved|rejected`（**不是 mock 的 normal**）、档位**没有 approved**（部分索引谓词 `review_state <> 'approved'`）；② 「AI 转人工」是 `review_verdict='review'`，取自 review_events **不从三态推**（C11）；③ 判定必带 `expected_updated_at`（队列项的 `updated_at`），版本冲突是**预期内的 400**，界面如实说「请刷新队列重判」。删掉了 mock 的「请求修改」（后端 action 只有 approve|reject）与那张**编出来的**判定时间线（队列 DTO 只带最近一次，没有多事件读口）。
  - 证据：`cd web && npx tsc --noEmit` → 无输出；`npx vitest run` → `Test Files 28 passed (28) / Tests 148 passed (148)`；`pnpm lint` → `19 problems (0 errors, 19 warnings)`，我的文件里没有 error。字段核对：`review_state`/`review_source`/`review_verdict`/`reviewer`/`reviewed_at`/`updated_at` 逐个对 `forum/internal/forum/review_queue.go` 的 `ReviewQueueItemDTO`；`expected_updated_at` 对 `forum/handler.go:171` 的 `reviewTopicBody`（`binding:"required"`）。
  - 下一步：**reports 屏**（`screens/reports.tsx`）改 prop 驱动，容器加 `ReportsScreenContainer`；端点 `GET /admin/reports?state=&target_type=&limit=&cursor=`（`{data,next_cursor}`）、`PATCH /admin/reports/{id}` body `{state:"handled"|"dismissed", note}`、`POST /admin/reports/batch` body `{ids,state,note}` → `{results:[{id,ok,code}]}`（**逐条成败**，别按整批原子处理）；字段照 `forum/internal/report/dto.go` 的 `Report`（`target_label` **不是** mock 的 `target_title`、`open_reports` 是同一目标的未处理数）。
  - 阻塞：同下（`GET /admin/users` 等三条端点仍未落地）。
- [x] **出图脚手架（B8 的延伸）**：`/admin/*` 不在 `product.html` 的 route 表里，而那个文件是共享写入点（当时另一个人在改 `product-fixture.ts`）——所以后台**自己一个入口**：`web/admin.html` + `src/preview/admin-preview.tsx`（真壳 + 真路由 + 真屏，只换桩数据，桩在 `src/preview/admin-fixtures.ts`），加一个只按 PID 关自己 chrome 的 `web/scripts/shoot-admin.ps1`。12 屏全部出图成功。
  - 证据：`npx vite --config vite.preview.config.ts --port 5212 --strictPort`（我的号段，5199 归别人）→ `& .\web\scripts\shoot-admin.ps1` → `OK review 113947 bytes / OK reports 123944 / OK rewards 134478 / OK roles 125493 / OK titles 106258 / OK mail 127678 / OK settings 136667 / OK audit 149502 / OK ai 126363 / OK boards 59083 / OK diagnostics 55711 / OK users 94489`，`失败 0 张`。看过的图：`review-1440.png`（AdminShell 面包屑 + 当前管理员卡 + 权限明细，队列两条、AI 转人工高亮、状态机写的是 `pending|approved|rejected`）、`boards-1440.png`（PendingScreen 明写缺 `GET /admin/boards`）、`users-1440.png`（**用户列表没能加载（HTTP 404）：接口不存在** —— 后端真没有这条路由，图上是这个真状态，不是示例表）。图上左下角 `MARKER-ADMIN /admin/<屏>` 是「拍的是当前源码」的凭据。
  - 下一步：把 8 个端点已就绪的屏逐个改成 prop 驱动（reports → rewards → roles → titles → mail → settings → audit → ai），每屏一个提交；容器都加进 `routes/admin-screens.tsx`。
  - 阻塞：**动了 3 个共享写入点**（交接单 §2 冻结清单）：`web/vite.preview.config.ts`（rollupOptions.input 加 `admin: 'admin.html'`）、`web/src/preview/product.tsx`（route 表加 `/admin`、`/admin/*`）、`web/src/preview/product-fixture.ts`（`?asAdmin=1` 换管理员身份 + 转调 admin-fixtures + 未知 `/admin/*` 回 404）。都是**加法**，但 Lead 要合这两条时请留意 `product-fixture.ts` 与 W-D1 的改动在同一文件。
- [x] **reports 屏**（`screens/reports.tsx`）prop 驱动 + `ReportsScreenContainer`，接 `GET /admin/reports`（游标入 key）、`PATCH /admin/reports/{id}`、`POST /admin/reports/batch`。照后端纠正：① 行标题字段是 **`target_label`**（mock 写的 `target_title` 在本仓库造成过一次「每行标题恒空白」，交接单 §5.1）；② `open_reports` 直接用后端算好的「同目标未处理数」，**不自己数**；③ 批量是**逐条 CAS + 逐条结果**（`BatchResult.results`），所以屏上把「N 条成功、M 条失败」显式画出来，并写明「成功的那些已经生效、失败的要单独重试」，不假装整批原子。删掉了 mock 里那颗「就地删除被举报内容」——队列 DTO 没带「我能不能删这条」的判定（`/me` 只给 `board_ids` 数字、队列给 slug），要做得先有那个读口。
  - 证据：`npx tsc --noEmit` → 我的文件 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens reports` → `OK reports 123944 bytes`（图在 `shots/wd2/reports-1440.png`，看过：队列 2 条待处理、`同目标还有 1 条未处理` 那行来自 `open_reports`、右栏状态机与「就地删除不在这里」的说明都在）。
  - 下一步：**rewards 屏**（`screens/rewards.tsx`）prop 驱动，容器 `RewardsScreenContainer`；端点 `GET /admin/rewards?state=&limit=&cursor=`（`{data,next_cursor}`）、`POST /admin/rewards/{id}/verify` body `{state:"approved"|"rejected", note}`、`POST /admin/rewards/batch`（同形状，逐条结果）、`GET /admin/rewards/stats?top=`、`GET/PATCH /admin/donation-notice-defaults`（**整表替换** body `{items:[{channel,text}]}`，channel 值域 `default|wechat|alipay|other`）；字段照 `forum/internal/reward/dto.go` 的 `Donation`（`amount_cents` 是整数分、只在展示时除 100；`verifier`/`verified_at` 是 omitempty）与 `DonationStats`（`public_*` 只算双方都同意公开的）。
  - 阻塞：同上（`GET /admin/users`、`/admin/boards*`、`/admin/diagnostics` 仍未落地 → 三屏渲染 PendingScreen）。
- [x] **rewards 屏**（`screens/rewards.tsx`）prop 驱动 + `RewardsScreenContainer`，接 `GET /admin/rewards`、`POST /admin/rewards/{id}/verify`、`POST /admin/rewards/batch`、`GET /admin/rewards/stats?top=10`、`GET/PATCH /admin/donation-notice-defaults`（**五条都已在**）。照后端纠正四处：① 状态值域 `pending|approved|rejected|withdrawn`；② `VerifyInput` 的 oneof **只有 approved|rejected** —— `withdrawn` 是申报人自己的动作，所以屏上**删掉了 mock 的「撤回」按钮**（点了必 400）；③ 「不计入公开统计」= `all_count - public_count`（原 mock 编了一个后端没有的 `hidden_count`）；④ 收款码：这一屏**拿不到那个渠道的图**（没有按 id 读渠道的端点），所以右栏不画假的二维码占位图，只如实显示 `channel_id`。金额一律整数分、只在展示时除 100。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens rewards` → `OK rewards 111078 bytes`；看过 `shots/wd2/rewards-1440.png`：`¥1500.00 / ¥3200.00 / 不计入公开统计 14` 三格来自 `public_total_cents / all_total_cents / all_count-public_count`，排行榜与「按渠道的默认提示文案」（整表替换、有未保存态）都在。
  - 下一步：**mail 屏**（`screens/mail.tsx`）prop 驱动，容器 `MailScreenContainer`；端点 `GET/POST /admin/mail/accounts`、`PATCH/DELETE /admin/mail/accounts/{id}`、`POST /admin/mail/accounts/{id}/test` body `{to}` → `{mail_log_id}`；字段照 `forum/internal/mail/dto.go` 的 `AdminAccount`（**密钥只有 `secret_configured` + `secret_updated_at`，永不回显**；`options_json` 是 RawMessage）与 `AccountPatch`（**只写传进来的字段**，nil = 不动）。测试发信要一个收件地址，它**必须由人填**（不能默认发给当前管理员）。
  - 阻塞：同上（`GET /admin/users`、`/admin/boards*`、`/admin/diagnostics` 未落地 → 三屏 PendingScreen）。
- [x] **titles 屏**（`screens/titles.tsx`）prop 驱动 + `TitlesScreenContainer`，接 `GET/POST /admin/titles`、`PATCH /admin/titles/{id}`。照后端纠正三处：① 字段是 **`archived_at`（时间戳，null = 未归档）**，不是 mock 的 `archived` 布尔；② 后端**没有 `holders`（持有者数）**——屏上那一格写「—」并注明「不是 0，是不知道」，**不拿 0 冒充**（本仓库出现过稳定显示假 0 的账：I6）；③ `PATCH` 的 body 是 **TitleInput 全字段**（不是「只传改动」），所以编辑表单整份提交，恢复/归档也走同一条路。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens titles` → `OK titles 72507 bytes`；看过 `shots/wd2/titles-1440.png`：三条（含一条已归档的 `2026-08-01`）、状态列与「恢复 / 归档」分档正确、持有者数那一格是「—」。
  - 下一步：**mail 屏**（`screens/mail.tsx`）prop 驱动，容器 `MailScreenContainer`；端点 `GET/POST /admin/mail/accounts`、`PATCH/DELETE /admin/mail/accounts/{id}`、`POST /admin/mail/accounts/{id}/test` body `{to}` → `{mail_log_id}`；字段照 `forum/internal/mail/dto.go` 的 `AdminAccount`（**密钥只有 `secret_configured` + `secret_updated_at`，永不回显**）与 `AccountPatch`（只写传进来的字段）。测试发信要一个收件地址，**必须由人填**（不能默认发给当前管理员）。`status` 值域照后端（`ok` / `disabled` / 其它），不要照 mock 的 `active / archived`。
  - 阻塞：同上。
- [x] **mail 屏**（`screens/mail.tsx`）prop 驱动 + `MailScreenContainer`，接 `GET/POST /admin/mail/accounts`、`PATCH/DELETE /admin/mail/accounts/{id}`、`POST /admin/mail/accounts/{id}/test`。照后端纠正四处：① **密钥只写不回显**（`AdminAccount` 只有 `secret_configured` + `secret_updated_at`），编辑区不出现「当前密钥」；② `PATCH` **只写传进来的字段**（`AccountPatch` 全是指针，nil = 不动）→ 每一项都是**显式保存**，只发改过的键；③ 测试发信要 `{to}`（后端 `binding:"required,email"`）→ **收件地址必须人填**，不默认发给当前管理员；④ `status` 是后端给的健康态字符串，**原样显示**，不编中文标签也不假设只有两值（mock 的 `active/archived` 是编的）。另外把「测试发信入队成功 ≠ 对方收到」写进了回执文案（去 mail_logs 看结果）。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens mail` → `OK mail 103281 bytes`；看过 `shots/wd2/mail-1440.png`：两个账号（一个 `已配置`、一个 `未配置` + 失败 24 天前）、启用开关、额度进度条按 `reset_tz` 显示都在。
  - 下一步：**settings 屏**（`screens/settings.tsx`）prop 驱动，容器 `SettingsScreenContainer`；端点 `GET /admin/site-settings` → `{items: SettingItem[]}`（**键值目录、label、kind、options、hint 全由后端给**，前端不再自己维护一张键表）、`PATCH /admin/site-settings` body `{values:{key:value}}`（**只写传进来的键**）、`GET /admin/site-domains`（只读）、`GET/POST /admin/announcements` + `PATCH /admin/announcements/{id}`、`GET/POST /admin/banners` + `PATCH /admin/banners/{id}`（`Banner.roles` 空 = 所有人）。
  - 阻塞：同上。
- [x] **settings 屏**（`screens/settings.tsx`）prop 驱动 + `SettingsScreenContainer`，接 `GET/PATCH /admin/site-settings`、`GET /admin/site-domains`、`GET/POST /admin/announcements` + `PATCH`、`GET/POST /admin/banners` + `PATCH`。照后端纠正三处：① **键值目录由后端给**（`SettingItem` 自带 `key/label/grp/kind/options/value/hint`）—— 前端不再维护第二张键表（那张表必然漂移，而漂移的表现是「设置项在后台根本看不见」，老站 13 个 `site_texts` 键就是这么全丢的）；② `kind` 按后端值渲染（`toggle|select|multiline|text`，其余按 text），toggle 的值按 `on/true/1` 都算开；③ `PATCH` **只写传进来的键**（`SettingsInput.values` 是 map）→ 只发改动过的键，按钮上写明「保存 N 项改动」。域名是**只读**（真源是配置里的 base_url，拍板 §8.11 U2），屏上明写「没有写端点、不假装能改」。草稿与「它对应的是后端哪一版」放同一个 state：后端值一变就整份换掉，避免旧草稿覆盖新值。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens settings` → `OK settings 110464 bytes`；看过 `shots/wd2/settings-1440.png`：`kind=toggle` 渲染成开关、`kind=select` 渲染成下拉（这对「用后端给的 kind」是实证）、公告的「发布/启用」是两件事、域名表只读。
  - 下一步：**audit 屏**（`screens/audit.tsx`）prop 驱动，容器 `AuditScreenContainer`；端点 `GET /admin/audit-logs?target_type=&target_id=&action=&actor=&from=&to=&limit=&cursor=`（`{data,next_cursor}`）与 `GET /admin/audit-logs/export?format=csv`；字段照 `forum/internal/auth/audit.go` 的 `AuditItem`（`id` 是**数字**、`detail` 是 jsonb map、`actor` 可为 null = CLI/系统动作、`ip` 是字符串）。**导出走 `<a href>` 直下文件、不走 fetch**（前端方案 §5 的 fetch 唯一出口管不到它），导出需要 `audit.export`（与 `audit.view` 是两个点）。
  - 阻塞：同上。
- [x] **audit 屏**（`screens/audit.tsx`）prop 驱动 + `AuditScreenContainer`，接 `GET /admin/audit-logs`（target_type/target_id/action/actor/from/to/游标）与 `GET /admin/audit-logs/export?format=csv`。照后端纠正三处：① **动作名照后端常量**（`auth/audit.go` + 各域 deps.go 的 `Action*`）—— mock 里的 `user.permission.grant` / `user.role.change` / `board.moderate.grant` 在后端**一个都不存在**（真名 `permission.grant` / `user.role.assign`）；② `id` 是**数字**（游标才是不透明串），所以 `rowKey` 用 `String(l.id)`；③ `actor` 可为 null（CLI / 系统任务）、`detail` 是 jsonb → 详情列展示 `JSON.stringify` 的截断，**不编中文摘要**。导出走 `<a href>` 直下文件（fetch 唯一出口管不到浏览器下载），权限点 `audit.export` 与 `audit.view` 分开，缺了就明写「能看日志不等于能把全站操作人行为带走」。「只看提权类 / 系统任务」这两档后端没有对应参数（它们各自是**多个动作** / **actor 为空**），所以在前端筛本页，并在屏上说明。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens audit` → `OK audit 104394 bytes`；看过 `shots/wd2/audit-1440.png`：`导出 CSV` 按钮出现（`audit.export` 在 perms 里）、提权类 2 条带红标、`actor` 为空那行显示「系统 / CLI」、详情列是 jsonb 原文。
  - 下一步：**roles 屏**（`screens/roles.tsx`）prop 驱动，容器 `RolesScreenContainer`；端点 `GET /admin/roles` → `RoleItem[]`（`id` 是**数字**、`perm_keys` 是已展开的并集、`badge_color`/`is_super`/`user_count`）、`GET /admin/permissions` → `PermItem[]`（`key/group/name/description`）、`PATCH /admin/roles/{id}/permissions` body `{perm_keys: string[]}`（**全量替换**，空数组 = 清空）。**后端没有「新建角色 / 删除角色」端点**（§5.2 只列了矩阵），所以 mock 里的「新建自定义角色」「删除该角色」两个按钮必须删掉，不能只是禁用。超管的矩阵只读（`is_super`）。
  - 阻塞：同上。
- [x] **roles 屏**（`screens/roles.tsx`）prop 驱动 + `RolesScreenContainer`，接 `GET /admin/roles`、`GET /admin/permissions`、`PATCH /admin/roles/{id}/permissions`（**全量替换**，空数组 = 清空）。照后端纠正四处：① `RoleItem.id` 是**数字**（后端自增主键），不是 mock 的字符串 id；② **删掉 mock 的「新建自定义角色 / 删除该角色」两颗按钮** —— 后端**没有**这两个端点（§5.2 只列了矩阵读法），点了必然 404；不是禁用而是不画；③ **后端 `RoleItem` 没有 `parent_id`**（只给 `depth` 与「已展开的并集」`perm_keys`），所以「继承自父角色（写穿）」这条提示与「子 ⊇ 父」自检在这屏上做不到 —— 屏上明写「这一屏做不到」，交给 DB §12 自检 2，而不是编一条出来；④ 权限点目录用后端的 `group` 分组、`name`/`description` 做 help 文案。清空矩阵走 `ConfirmDialog`（危险动作 + 说清影响几个用户）。
  - 证据：`npx tsc --noEmit` → 0 错；`& .\web\scripts\shoot-admin.ps1 -Screens roles` → `OK roles 103069 bytes`；看过 `shots/wd2/roles-1440.png`：`普通用户` 勾了 `topic.create`（`perm_keys` 真在起作用）、「当前 2 个点 → 保存后 2 个」、分组计数 `内容 1/2`、超管那一档的只读说明都在。
  - 下一步：**ai 屏**（`screens/ai-review.tsx`，交接单 H2）prop 驱动，容器 `AiReviewScreenContainer`；端点 `GET/PATCH /admin/ai/config`、`POST /admin/ai/config/secret`、`POST /admin/ai/test`；字段照 `forum/internal/aireview/dto.go` 的 `ConfigView`（**密钥永不回显，只有 `has_secret` 与 `secret_updated_at`**；`prompt` 与 `prompt_report` 是**两栏**，第二栏给举报复核）+ `ConfigPatch`（***nil = 不动**）+ `TestView`（`verdict/reason/categories/model/latency_ms/raw`）。权限点是 `site.setting`（不新造）。`PATCH` 要只发改动过的字段。
  - 阻塞：同上。
- [x] **ai 屏**（`screens/ai-review.tsx` + `screens/ai-bits.tsx`）prop 驱动 + `AiReviewScreenContainer`，接交接单 H2 的四条：`GET/PATCH /admin/ai/config`、`POST /admin/ai/config/secret`、`POST /admin/ai/test`。字段照 `aireview/dto.go` 的 `ConfigView`（**密钥永不回显，只有 `has_secret` + `secret_updated_at`**；`prompt` 与 `prompt_report` 是**两栏**）、`ConfigPatch`（**nil = 不动** → 屏上收集「改动过的键」再发）、`TestView`（`verdict/reason/categories/model/latency_ms/raw`）。**删掉 mock 的「用量与失败率」两栏**（没有 `GET /admin/ai/stats`）与 **「拿某篇内容试跑」的整块表单**（`POST /admin/ai/test` **不绑定任何入参**，它发的是配置里那段提示词 + 固定短文本）——屏上明写这两件「后端还没有」，以及要做得先给 test 加 `{title, content, trigger}`。权限沿用 `site.setting`（不新造）。
  - 证据：`npx tsc --noEmit` → 我的文件 0 错（剩一条 `scripts/shoot-kfe.ts` 是别人在途的）；`& .\web\scripts\shoot-admin.ps1` → `OK ai 151195 bytes`；看过 `shots/wd2/ai-1440.png`：API Key 那一格只有「已配置 + 更新时间」（**密钥框是空的输入框，不是回显**）、两栏提示词各带字数、连通测试那一栏写明「没有入参、没有试跑表单」。
- [x] **12 屏的容器全部落地**（boards / diagnostics 除外，见阻塞），并**按 gate:size 拆分**：`routes/admin-screens.tsx`（690 行）拆成 `routes/admin/{_shared,users,roles,review,reports,rewards,titles,mail,settings,audit,ai}.tsx`。同时**去掉了屏级的 `lazy()`**：容器要 import 屏，再包一层 lazy 只会把同一份代码切成两半、多一次往返；整块切分由路由层负责（`router.tsx` 里 `/admin/*` 是 lazy 的）。
  - 证据：`node scripts/check-size.ts` → `检查 290 个文件，超限 1 个，登记 1 个` + `文件体量门禁通过`（唯一超限的是**别人的** `routes/messages.tsx 646 行`，且在 PENDING 里登记过）；`& .\web\scripts\shoot-admin.ps1`（12 屏）→ 全部 `OK`、`失败 0 张`。
  - 下一步：等 W-D1 的 `GET /admin/users` 落地后把 `routes/admin/users.tsx` 的筛选参数按真 DTO 复核一遍（他现在写的是 `q/status/role/activated/email_verified` 两个布尔，我的客户端已按这个形状写好）；`boards` / `diagnostics` 两屏等 C2 / C3 的端点，落地后按同样形状补容器即可（屏本身还是 mock 版，需要一起改成 prop 驱动）。
  - 阻塞：`GET /admin/users`（C1）· `/admin/boards*`（C2）· `GET /admin/diagnostics`（C3）仍未落地 → `users` 屏如实显示 404、`boards`/`diagnostics` 渲染 `PendingScreen`（图上明写缺哪条端点）。**没有拿示例数据兜底。**

## 收工状态（2026-10-14）

**做完了 10 屏**（合同要求的「每屏一个提交」）：users（等端点，见下）· review · reports · rewards · roles · titles · mail · settings · audit · ai。
**12 屏的取数容器与路由接线全部就位**；`boards` / `diagnostics` 两屏仍渲染 `PendingScreen`（端点未落地）。
**两条纪律的落点**：`AdminShell`（面包屑 + 当前管理员卡 + 权限明细）已是唯一的后台骨架；
`ConfirmDialog` / `DangerAction` 在 users（封号/解封）、review（拒绝）、reports（驳回）、rewards（拒绝）、
titles（归档）、mail（删除）、roles（清空矩阵）、ai（换密钥）八处都是唯一入口，**理由必填 + 二次确认**。

### 验收证据（本轮最后跑的一次）
- `cd web && npx tsc --noEmit`：我的文件 **0 错**（唯一一条在别人的 `scripts/shoot-kfe.ts`，未跟踪的在途文件）。
- `cd web && npx vitest run`：`Test Files 32 passed (32) / Tests 164 passed (164)`。
- `cd web && node scripts/check-size.ts`：`检查 290 个文件，超限 1 个，登记 1 个` + `文件体量门禁通过`（唯一超限的是**别人的** `routes/messages.tsx`，在 PENDING 里）。
- `cd web && node scripts/check-budget.ts`：`首屏 JS 148.7 KB / 150.0 KB`、`首屏 CSS 37.4 KB / 40.0 KB`、`最大路由 chunk 96.0 KB / 120.0 KB`、`产物体积门禁通过`。**注意首屏只剩 1.3 KB 余量**（不是我这一块造成的：/admin/* 是路由级 lazy）。
- `& .\web\scripts\shoot-admin.ps1`（12 屏）：全部 `OK`、`失败 0 张`，产物在 `shots/wd2/`（仓库外层的 shots 已 gitignore）。
- 看过的图（**每张都带左下角 `MARKER-ADMIN /admin/<屏>`**，证明拍的是当前源码）：`review-1440`、`reports-1440`、`rewards-1440`、`roles-1440`、`titles-1440`、`mail-1440`、`settings-1440`、`audit-1440`、`ai-1440`、`users-404`（真 404 态）、`boards-1440`（PendingScreen）、`diagnostics-1440`、`permission-denied`（**非默认态**：无 `audit.view` 的普通成员进 /admin/audit → 403 并写明缺哪个点）、`review-390`（窄屏）。
- 后端：**没有碰 `forum/**` 一行**，所以不需要跑 Go 测试。

### 出图入口（B8 的延伸）
`/admin/*` 不在 `product.html` 的 route 表里，而那个文件是共享写入点 —— 所以后台**自己一个入口**：
`web/admin.html` + `src/preview/admin-preview.tsx`（真壳 + 真路由 + 真屏）+ `src/preview/admin-fixtures.ts`（桩，
**故意不给 /admin/users、/admin/boards*、/admin/diagnostics，让图上看得见真实的 404**）。
`web/vite.preview.config.ts` 的 `rollupOptions.input` 里加了 `admin: 'admin.html'`。
**后来 `product.tsx` 的 route 表也加了 `/admin` 与 `/admin/*`**（见 fdd7f3b），所以
`product.html?route=/admin/review&asAdmin=1` 现在同样能出后台的图 —— 两条路都通。

### 留给下一个人的三件事（按价值排序）
1. **`GET /admin/users` 一落地就接 users 屏**：屏已经 prop 驱动改完、容器在 `routes/admin/users.tsx`，
   缺的只是端点。**筛选参数按真 DTO 复核一遍**：W-D1 的 `auth/pgsql/admin_users.go` 用的是
   `q / status / role / activated(bool) / email_verified(bool)`，而 `activated` 与 `email_verified` 是
   **两根独立的轴** —— 我的客户端已按这个形状写好（`lib/api/admin-types.ts` 的 `AdminUserFilter`），
   但 `AdminUser` 那个类型是**按 C1 的验收清单推的**，端点落地后必须逐字段复核（类型上有 `shortcut:` 注释标了）。
2. **`boards` / `diagnostics` 两屏**：C2 的 `/admin/boards` 整组**已经在工作区落地了**（W-D1 的
   `forum/internal/forum/admin_boards*.go`），`GET /admin/diagnostics`（C3）还没有。补法是照本轮的形状：
   把 `screens/boards.tsx` 改成 prop 驱动 + 在 `routes/admin/` 加一个容器文件 + 在 `admin.tsx` 的映射表里
   把 `PendingScreen('boards')` 换成容器。
3. **侧栏的 badge 还是 mock 数字**（`nav.ts` 里 users 的 12 / review 的 4 / reports 的 3 / rewards 的 4）：
   真实件数要逐屏查一次，而现在屏自己的调用方才知道。**我特意没改**：那会往 `nav.ts` 塞进「谁来填」的问题，
   而它不在本轮范围。

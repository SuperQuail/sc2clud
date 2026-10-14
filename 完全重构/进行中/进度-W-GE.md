# 进度 · W-GE（交接单 §4.G 与 §4.E）

包：G1 通知静音 / G2 撤回私信 / G3 找回密码整页 / E2 D7 时区 / G5 消息屏蔽词。

## 计划（先写骨架，再动手）

- [x] G1 通知静音（**只做类别级**，理由见「发现 4」）：`social.ts` 加 `muteNotificationKind(type)`
      与 `clearNotificationMute(body)`，`messages.tsx` 的 `NoticesPane` 给每行加「不再通知此类」。
- [x] G2 撤回私信：`notice-chat.tsx` 加 `renderActions(message)` 逐条动作槽位（登记表已更新），
      `messages-panel.tsx` 透传，`routes/messages.tsx` 给自己发的那条挂「撤回」→ DELETE /messages/{id}。
- [ ] G3 找回密码整页：`/forgot` 路由 + 接线（router.tsx 是 Lead 的 → 先写阻塞）。
- [x] E2 D7：todayStart 改成按站点时区（`forum/topics.go` 的 `todayStart/siteTZ/DefaultSiteTZ`），
      时区从 `config.Site.Timezone` 来（新增配置项 + Validate + `Site.Location()`），`forum.Deps.TZ` 注入。
- [ ] G5 消息屏蔽词：先定语义写在这里，再决定做/不做。

## 与任务描述的现状差异（先记下来，免得接手的人按旧描述找文件）

1. **E2 的 `todayStart()` 不在 `forum/internal/forum/pgsql/topics.go`**：它在 `forum/internal/forum/topics.go:57`
   （`func (s *Service) todayStart()`），pgsql 只在 `boards.go:44` 的注释里提到它。硬编码是 `Add(8*time.Hour)`。
2. **G2 的前端客户端函数已经在**：`web/src/lib/api/messages.ts:60` 的 `deleteMessage(id)` 已存在
   （`DELETE messages/{id}`）。缺的只有 UI 落点（气泡动作槽位）。
3. **G1 的前端零调用属实**：`social.ts` 里没有任何 `notifications/mutes`。
4. **G1 的「按内容静音」前端做不了（实测契约，2026-10-14）**：按内容静音要求
   `target_key = "<ref_type>:<内部 id>"`（0007 的 `ck_notification_mutes_key`），而通知 DTO 的
   `payload.ref_id` 就是**内部 id**（`notify/types.go` 的 RefID，与 `CreateInput.RefID` 同源）——
   前端**拿不到** public id 与内部 id 的换算，也没有任何端点返回它。
   所以 `type='link'` 那条路前端只能拿 public id 去撞，结果是「接口 204、静音一条谁都不认识的行」。
   **决定：只做类别级静音**（`{type: n.kind}`，muteKey 认这条路），文案写「不再通知此类」——
   点「回复我的」那一档会在**全站**静音回复通知，这是这次能提供的最诚实的动作。
   按内容静音要落地必须先补「通知 DTO 带上可静音的 ref 键」或「GET /mutes + 按 ref 静音」，记在阻塞里。
5. **后端没有 `GET /notifications/mutes`**：列表里无法显示「这一类已静音」。本屏里点过的记在本地 state。

6. **产品预览里 `/messages` 整页崩（新发现，不在我的作用域）**：`web/src/preview/product-fixture.ts:216`
   给会话页返回的是 `{ data: { peer, items }, next_cursor }`，而真契约是 `{ data: [...], next_cursor, peer }`
   （d4 §5.2 / `client.ts` 的 `apiEnvelope`）。于是 `thread.data.items` 拿到对象、
   `routes/messages.tsx` 的 `items.slice()` 抛 TypeError，整页落进错误边界（实测：`/messages/demo-admin`
   出图得到「页面出错了」）。**这是「私信页出不了产品图」的根因**，修法是一行：
   `return { body: { data: THREAD.items.slice().reverse(), next_cursor: null, peer: THREAD.peer } };`
   `product-fixture.ts` 不在我的作用域，请 Lead 改（E2 之外我没有动它，只在 `THREAD.items` 上补了
   真 DTO 有的 `mine` 字段——见下条）。

## 步骤记录

- [x] 第 1 步（2026-10-14）：E2/D7 站点时区 + G1 通知静音（**同一个 commit**，两条都小）。
  - 做了什么：
    · E2：`config.Site.Timezone`（默认 `Asia/Shanghai`）+ `Site.Location()` + `Validate` 拒绝非法 IANA 名；
      `forum.Deps.TZ` 注入；`forum/topics.go` 的 `todayStart()` 改成
      `n := s.clk.Now().In(s.tz); time.Date(n.Year(), n.Month(), n.Day(), 0,0,0,0, s.tz)`；
      app 层 `modules.go` / `seed.go` 各加三行接线（**接线必须，见阻塞**）。
    · G1：`social.ts` 加 `muteNotificationKind`（PUT `{type}`）+ `clearNotificationMute`；
      `routes/messages.tsx` 的 `NoticesPane` 给 `NoticeRow.actions` 加「不再通知此类」（BellOff 图标）。
  - 证据：
    · `& go test ./internal/forum/... ./internal/config/... -count=1`
      → `ok forum/internal/forum 61.525s` / `ok forum/internal/forum/pgsql 11.777s` / `ok forum/internal/config 1.276s`
    · **新用例证明会红**：临时把 `todayStart` 换回 `now().UTC().Add(8*time.Hour)` 后
      `go test ./internal/forum/ -run TestListBoardsTodayUsesConfiguredTimezone -count=1`
      → `tz_test.go:53: UTC-11 站点：昨天 21:00Z 应算昨天（today_count=0），实际 1 —— 时区没跟着配置走` / `FAIL`
      （随后按字节还原，`git diff --stat forum/internal/forum/topics.go` 只剩我的 25 行改动）
    · **G1 用例证明会红**：把 `muteNotificationKind` 的 body 改成 `{type, ref_type:'post', ref_id:1}` 后
      `npx vitest run src/routes/messages.test.tsx` → `Tests 1 failed | 2 passed`，
      红在 `expect(writes[0]!.body).toEqual({ type: 'sanction' })`；还原后 3 passed。
  - 下一步（**G2 撤回私信**，文件+函数+改成什么）：
    1. `web/src/ui/message/notice-chat.tsx` 的 `NoticeChat`：给 `ChatMessage` 加可选
       `actions?: ReactNode`，在气泡（`m.html` 那个 div）下方 `m.note` 旁边渲染这一格；
       已有调用方（`10-messages/messages-panel.tsx`）不传就什么都不变 —— 10-messages 那屏与
       `messages.test.tsx` 必须仍然全绿。
    2. `web/src/routes/messages.tsx` 的 `MessagesPane`：`deleteMessage`（`lib/api/messages.ts:60` 已在）
       接一个 `useMutation`，`onSuccess` 里 invalidate `qk.thread(handle)` + `qk.conversations()`；
       每一颗气泡的 `actions` 传一个 Ring `Button`（`inline={false} height={ControlsHeight.S} ghost danger`
       `icon={icon16(Trash2)}`），**只有 `m.mine` 且 `id` 非空时才给**（后端 DELETE 的语义是
       「各自删除」：只置我这一侧的标记，对方照常看得见）。
    3. 用例：`web/src/routes/messages.test.tsx` 加一条渲染 `NoticeCenter panel='messages'` +
       `/messages/:handle` 的用例，断言点了撤回之后 `writes` 里有 `DELETE /api/v1/messages/{id}`。
  - 阻塞：
    · **不是阻塞、但要 Lead 知道**：E2 的接线动了 `forum/internal/app/modules.go` 与 `seed.go`
      （各加 3~5 行取 `cfg.Site.Location()` 并塞进 `forum.Deps.TZ`）。这是「接线必须」那一类，
      已在同一个 commit 里。**要不要把 `config` 也加进我的作用域由 Lead 定**（我改了
      `config/config.go`、`defaults.go`、`validate.go`、`load_test.go`）。
    · **G1 缺后端能力（要 Lead 排期，不是我能在前端糊上的）**：
      ① 通知 DTO 没有「可静音的 ref 键」→「这条内容不再通知」做不了（发现 4）；
      ② 没有 `GET /notifications/mutes` → 界面无法显示「已静音」态、也无法取消（本次只在本地记账）。
    · E1（公告区两档门槛）、G5（屏蔽词语义）尚未开工。

- [x] 第 2 步（2026-10-14）：G2 撤回私信（控件槽位 + 落点 + 用例）。
  - 做了什么：
    · `web/src/ui/message/notice-chat.tsx`：`NoticeChat` 加 `renderActions?: (message: ChatMessage) => ReactNode`，
      气泡下方渲染这一格；**没有动作时不渲染空节点**。这是已登记控件的**加法**（不改既有 props 语义），
      10-messages 不传它 → 那一屏的行为与之前逐字相同。
    · `web/src/devroom/pages/10-messages/messages-panel.tsx`：加 `renderMessageActions` 并透传给 `NoticeChat`。
    · `web/src/routes/messages.tsx`：`MessagesPane` 加 `retract` 变更（`deleteMessage` → invalidate
      `qk.thread`/`qk.conversations`），`bubbles` 带上 `mine`，**只有自己发的那条**给「撤回」。
      不做乐观删除：游标分页下本地删一条会在下一页留一个洞（注释里写了）。
    · `web/src/devroom/registry.ts`：`notice-chat` 条目补上 `renderActions` 与 verify 日期。
  - 证据：
    · `npx vitest run src/routes/messages.test.tsx` → `Test Files 1 passed` / `Tests 4 passed`
      （新用例：`私信页：自己那条有「撤回」…`）
    · 全量 `npx vitest run` → `Test Files 28 passed (28)` / `Tests 147 passed (147)`（基线 146 → 147）
    · **变异验证会红**：把 `renderMessageActions` 的判定改成恒假后，
      同一用例 → `Unable to find an element by: [data-testid="message-retract-m-1"]` / `Tests 1 failed | 3 passed`；
      还原后 4 passed。
    · 出图：`node shots/wge-shot.mjs`（我的端口 5236/9236）→ `wge-notices-system.png` / `wge-notices-reply.png`
      与两张 390 窄屏图；图上读得到 `MARKER-PRODUCT-LOGIN /notifications?…`，三条系统通知各有一行
      「标为已读 | 不再通知此类 | 删除」，`overflow:false`、控制台问题：无。
      **私信那一页出不了图**，原因见「发现 6」（product-fixture 的桩形状不对，不在我的作用域）。
    · `npx eslint` 我改的 7 个前端文件 → `0 errors`（1 warning 是 messages-panel 早就有的
      `react-refresh/only-export-components`，来自 `plainText` 那个导出，不是我加的）。
  - 下一步（**G3 找回密码整页**，文件+函数+改成什么）：
    1. 新建 `web/src/routes/forgot.tsx`：`ForgotPage` 用 `AuthShell` + `FormAlert` + `CodeField` +
       `PasswordField`（都是 16-auth 的房子件，DevRoom `forgot-view.tsx` 是只读设计稿，**不要 import 它**），
       两步一页：`forgotPassword(email)`（恒 200，不暴露邮箱是否存在）→
       `verifyResetCode(email, code)` 拿 `reset_ticket` → `resetPassword(ticket, newPassword)`；
       成功页文案照设计稿「所有设备上的登录都已退出」。
    2. `web/src/routes/login.tsx` 的 `footer`：把「重置链路还没接…请管理员帮你重置」改成实话 +
       `href={appPath('forgot')}`。
    3. 用例 `web/src/routes/forgot.test.tsx`：断言三步各发的端点与字段名
       （`{email}` / `{email, code}` / `{reset_ticket, new_password}` —— 字段名照 `auth/handler.go`，
       本仓库踩过 `token`/`reset_ticket` 的坑）。
  - 阻塞：
    1. **/forgot 路由要挂**：`web/src/app/router.tsx` 是 Lead 的冻结文件（`const ForgotPage = lazy(...)`
       + `{ path: 'forgot', element: <ForgotPage /> }`）。我的页面与用例可以先落地，路由这一行请 Lead 加，
       否则整页不可达（与 `appeal` 那次同一形状的阻塞）。
    2. `web/src/preview/product-fixture.ts:216` 的会话页包络形状不对 → 产品预览里 `/messages` 整页崩
       （见「发现 6」）。修法一行，请 Lead 改。
    3. **`cd web && pnpm typecheck` 当前不是绿的，红的全在别人的在途文件里**（D1 的 W-D1：
       `web/src/routes/admin.tsx`（M 未提交）、`web/src/routes/admin-screens.tsx`（未跟踪）、
       `web/src/devroom/pages/15-admin/screens/users.tsx`、`web/src/ui/dev-entry.tsx`）。
       我这边用等价的隔离 tsconfig（把上述文件 exclude）跑 `npx tsc --noEmit` → `TSC-EXIT=0`；
       全量 typecheck 要等 W-D1 那条线收口。**我没有碰这四个文件。**
    4. `web/src/preview/product-fixture.ts` 的 `THREAD.items`：我补了真 DTO 里有的 `mine`（与 `peer`），
       否则「撤回」那条界面分支在预览里永远不渲染。**这动了共享文件一行**，如不合意请回退我那一处 edit。

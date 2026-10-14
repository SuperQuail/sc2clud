# 进度 · K-FE（前端 + 打赏整块 + 私信图片）

> 作用域：`web/src/routes/**`、`web/src/devroom/pages/**`、`web/src/lib/api/**`、
> `web/src/ui/message/notice-chat.tsx`（点名授权）、`完全重构/UI与后端对齐.md`、本文件。
> **不碰**：`web/src/app/**`、`web/vite*.config.ts`、`web/package.json`、`forum/**`。
> 依据：`08-拍板记录.md`（用户拍板）+ `07-一次性完工交接单.md`（环境/协议/陷阱）。
> 基线：`pnpm typecheck && pnpm lint && npx vitest run` 绿（28 文件 / 146 用例）；`go test ./...` 34 包绿。

## 队列（照 08 的顺序，一条一提交）

- [x] L1 打赏/赞助整块前端接线（收款码上传/删除、打赏、我的打赏记录、收款码可见性、SponsorCard/RewardPanel 接真数据）
- [ ] L2 首页/分区页「最热」排序（**阻塞**：等 K-BE 交 `sort=hot` 与字段名）
- [ ] L6 作者侧「打回修改」横幅 + 「查看最后过审版本」入口（**阻塞**：等 K-BE 加第四态 + 最后过审版本字段）
- [ ] J3 只显示点赞数；点踩数据按身份渲染（**阻塞**：等 K-BE 决定踩的下发口径）
- [ ] J5 Issue 检索/筛选界面补全（**阻塞**：等 K-BE 的三个新字段）
- [ ] J9 卡片用上 `cover_width`/`cover_height`（**阻塞**：等 K-BE 加字段）
- [~] L8 私信：Unicode 表情不被正文链路破坏**已做**（含会红用例）；发图片**阻塞**（media 没有通用图片上传端点）+ 图片按钮已改成禁用+原因
- [x] L7 「已提交复审」反馈真页面验证（出图看过）+ G5 消息屏蔽词 WIP 标记
- [x] L3 / L4 / L9 只写文档（AI 两套提示词 + temperature、Issue 标签表、搜索高亮/历史/热门词）→ `界面施工-后端需求变动.md §6.5`
- [x] `UI与后端对齐.md` 定位改错（「暂时隐藏」→「待接线 / 待落地」，并把已做完的条目改成现状）

## 阻塞（跨人依赖，先写清不造 mock 兜底）

- **L2**：需要 K-BE 的 `sort=hot` + 新游标键；字段名要照它交的变更表。
- **L6**：需要 `ck_topics_review_state` 加第四态（独立分类）与「最后过审版本」的存储/DTO 字段。
- **J3**：需要 K-BE 决定踩数（`dislike_count`）对谁下发；**接口不下发就不显示**，不在前端藏。
- **J5 / J9**：需要 K-BE 的 Issue 检索字段与 `cover_width`/`cover_height`。
- **L8**：`forum/internal/media/handler.go` 只有三条上传端点（`/me/avatar`、`/me/payment-channels`、
  `POST /topics/{id}/images`，后者绑在 topic 上）—— **没有通用图片上传端点**，私信发图无通道可复用。
  且 `message.MessageDTO.body` 是 `varchar(2000)` 纯文本（`message/service.go:133` `TrimSpace` + 2000 rune 上限），
  附加图需要正文形状变更或附件表。等 K-BE 交「图片通道 + 正文形状」后再接。
- **收款码的图对访客不可见（L1 的功能性缺口，前端无法补）**：`media/service.go:260` 写引用行时固定
  `VisibilityPrivate`（=2），而 `canView`（`media/service.go:441-457`）只在**所有者 / 超管 / 持
  `reward.verify`** 三种身份下放行。于是 `GET /users/{handle}/channels` 虽然给陌生人回了
  `{"image":"/img/<hash>"}`，那个 `<hash>` 对**登录的无关用户与游客都不可见** →
  `GET /img/<hash>` 回占位图（200 + no-store + `X-Img-Denied`），打赏面板上永远是一张占位图。
  已有用例把这条行为钉住了：`forum/internal/media/media_test.go:246 TestFetchImageVisibility`
  的「无关登录用户 / 游客 → allow=false」两格。
  **要 K-BE 定口径**（前端两条都不需要改）：①打赏是「扫码转账」语义，收款码本就该对访客可见
  → 写引用行时按渠道的展示开关选 `VisibilityLogin`/`VisibilityPublic`；或 ②保持私有，
  则由 `GET /users/{handle}/channels` 出一个**一次性签名/代理**的取图地址（`/img` 那条读路径不变）。
  在它落地之前，前端**不假装能扫**：图是 `<img src>` 原样引用，后端给什么就显示什么。

## 记录

- [x] **L1 第 1 步：把打赏域的前端客户端从零建起来**（新增 `web/src/lib/api/rewards.ts` + `rewards.test.ts`）。
  八条端点一次接齐：`GET /users/{handle}/channels`、`POST/GET/DELETE /me/payment-channels`、
  `POST /rewards`、`GET /me/rewards`、`GET /users/{handle}/rewards`、`GET/PATCH /me/donation-settings`、
  `DELETE /rewards/{id}`（撤回）。类型直接复用 `admin-types.ts` 已有的 `Donation`/`UserBrief`（不复制第二份 DTO）。
  - 证据：`cd web && npx vitest run src/lib/api/rewards.test.ts` → `Test Files 1 passed (1) / Tests 8 passed (8)`。
    **先证明会红**：把 `createDonation` 的路径临时写成 `'reward'` 再跑 → `1 failed | 7 passed`，
    `AssertionError: expected '/api/v1/reward' to be '/api/v1/rewards'`；改回 `'rewards'` 后 8/8 绿。
    全量：`npx vitest run` → `Test Files 30 passed (30) / Tests 158 passed (158)`；
    `pnpm lint` → `19 problems (0 errors, 19 warnings)`（都是既有的 react-refresh / exhaustive-deps 警告，非本次新增）。
  - 下一步：`web/src/routes/settings.tsx` 里加「赞赏与收款码」一节（新件
    `web/src/devroom/pages/11-profile/payment-channels.tsx`）：`useQuery(qk.donationSettings())` +
    `fetchMyDonations()` 列我的申报（撤回按钮走 `withdrawDonation`），收款码用
    `ImageUploader variant='avatar'` 选图 → `addPaymentChannel(file, label)`，列表项 `deletePaymentChannel(id)`；
    两个开关分别 PATCH `show_channels` / `records_public`；图一律过 `channelImageSrc()`。
    然后把 `web/src/routes/profile.tsx` 的 `SponsorCard` 与 `web/src/routes/topic.tsx` 的 `RewardPanel`
    接上真数据（两处现在分别写死 `channels={[]}` 与 `const channels = []`）。
  - 阻塞：**无**（本步只碰 `web/src/lib/api/**`）。
    另记一条**与本人无关的既有红灯**：`pnpm typecheck` 期间两度被**别人作用域**的在途文件打红
    （先 `15-admin/index.tsx` + `routes/admin.tsx` 的 `TitlesScreenProps`，后 `routes/admin-screens.tsx` 的
    `ESCALATION_ACTIONS`）—— 那些文件是 ` M` 在途状态，不是我改的；本轮收尾时它们已自行变绿。
    本步结束时 `pnpm typecheck` 0 错、`pnpm lint` 0 错 20 警告、`npx vitest run` 30 文件 158 用例全绿。

- [x] **L1 第 2 步：打赏整块接进真页面**（收款码上传/删除、可见性、打赏、我的打赏记录、两处入口接真数据）。
  新增 `devroom/pages/11-profile/payment-channels.tsx`（设置页那一节）与
  `devroom/pages/12-topic/donate-box.tsx`（**唯一一份**打赏面板，SponsorCard 与 RewardPanel 共用）；
  重写 `sponsor-card.tsx` / `reward-panel.tsx` 为 prop 驱动并删掉 `disableReason` 逃生口；
  接线 `routes/settings.tsx`、`routes/profile.tsx`、`routes/topic.tsx`。
  - 证据：`npx vitest run` → `Test Files 31 passed (31) / Tests 162 passed (162)`（新增
    `rewards.test.ts` 8 条 + `payment-channels.test.tsx` 4 条）。**三条新断言各证明过会红**：
    ① 把 `createDonation` 路径写成 `'reward'` → 1 failed；
    ② 去掉 `rows` 的 `Array.isArray` 兜底 → `settings.test.tsx` 2 failed + 页面刷 `TypeError: rows.map is not a function`；
    ③ 面板原先请求的是 `/users//channels`（空 handle），测试当场 404 红 → 改成本人真端点 `GET /me/payment-channels`。
    出图并**看图**（`web/scripts/shoot-kfe.ts`，图在 `shots/kfe/`，均含左下角 `MARKER-PRODUCT-…`）：
    `profile-sponsor-open-1440`（登录+有码：¥5/10/30/100、金额框、「先填金额」）、
    `profile-sponsor-filled-1440`（填 10 → 按钮变「我已完成 ¥10.00 的打赏」）、
    `profile-sponsor-guest-1440`（未登录：看得到码，登记段换成「去登录」）、
    `profile-sponsor-open-390`（窄屏整页，右栏掉到末尾不溢出）、`topic-reward-open-1440`（帖子右栏同一份）、
    `settings-rewards-1440/390`（收款码 + 删除 + 渠道名 + 上传 + 两个开关 + 我的打赏记录「给 示范管理员 ¥10.00 待核验 撤回」）。
  - 下一步：见下面两步（已做）。
  - 阻塞：**L1 已做完**。另有两处**跨人依赖**记在下面的「阻塞」一节（media 的私信图片通道、
    收款码图片对访客不可见 —— 后者要 K-BE 明确「重定向/可见性」口径，见该节末条）。
    收款码图片对访客不可见 —— 后者要 K-BE 明确「重定向/可见性」口径，见该节末条）。

---

- [x] **L1 收尾 + `UI与后端对齐.md` 定位订正**（文档，无产品代码）。
  三处改动：① 全文口径从「暂时隐藏」改成「**待接线 / 待落地**」，开头写明这是**一份账**、
  不是「哪些功能决定不做」；② 第一节补上打赏整块（附「收款码图对访客不可见」这个已知缺口）；
  ③ 第一/二节里所有已经做完的条目（用户搜索、通知静音、撤回私信、帖子申诉、申诉页、密码重置、
  消息设置面板）逐条改成现状 —— 它们原先还挂着旧的「缺什么」，读起来像还没做。
  - 证据：逐条核对来自代码事实 —— `web/src/app/router.tsx:25-27,59`（申诉页已上线，注释明说旧理由作废）、
    `routes/login.tsx:64,76`（登录页页脚已是真入口）、`lib/api/user.ts` 的 `searchUsers`、
    `lib/api/social.ts` 的 `muteNotificationKind`、`ui/message/notice-chat.tsx` 的逐条动作槽位。
  - 下一步：见下一条。
  - 阻塞：无。

- [x] **L8（可做的那一半）+ G5 标记 + L7 验证**（一条提交）。
  ① **L8 表情**：拍板要的是「允许用户复制 unicode 表情进去」，所以做的是**保证正文链路不破坏它**。
     新增 `devroom/pages/10-messages/messages-panel.test.ts` 三条：ZWJ 家庭 / 肤色修饰符 / 区域旗 /
     键帽 / 单码点各自原样穿过 `plainText`，并钉住「先剥标签、再解实体」的顺序。
     **证明会红**：给 `plainText` 临时加一句 `.replace(/[\uD800-\uDFFF]/g, '')`（= 抹掉所有非 BMP 字符）
     → 3/3 红，报错是 `expected '\u200d\u200d' to be '👨‍👩‍👧'`（ZWJ 留下、主体被削掉 —— 正是「按代理对切」的坏法）；
     改回后 3/3 绿。
  ② **L8 图片**：`messages-panel.tsx` 的「发送图片」从**假按钮**（点了没反应）改成**禁用 + title 写清原因**；
     「表情」按钮**按拍板删掉**（用户自己粘 Unicode）。新增 `messages-panel.test.tsx` 一条：断言它 disabled、
     title 里有原因、点了不发请求、页面上没有「表情」按钮。**证明会红**：把按钮改回假按钮 → 1 failed。
  ③ **G5**：`devroom/pages/11-profile/index.tsx` 的「屏蔽词」行加 **WIP 标记**（标题带 `WIP · 未实现`、
     hint 明说后端没有承载），并**移掉 onAdd/onRemove** —— 它们原先往本地列表塞「屏蔽词1」这种假词，
     正是 W-GE 交接时点名的「假装能用」；`setBlocked` 随之删掉。
  ④ **L7**：`review-state.tsx` 的横幅加第四档 `resubmitted`（文案「已重新提交复审」），
     与「首次投稿的 pending」「已转人工的 pending」区分；线从 `main-column.tsx` 铺到 `topic-view.tsx`，
     宿主 `routes/topic.tsx` 由「刚保存 + 服务端回了 pending」置位。
  - 证据：`npx vitest run` → `Test Files 34 passed (34) / Tests 168 passed (168)`；
    `pnpm lint` → `19 problems (0 errors, 19 warnings)`；`pnpm typecheck` 我改的文件 0 错。
    **L7 在真页面上验了一次**（不是只跑单测）：`web/scripts/shoot-kfe.ts` 的 `resubmitFlow` 真的点开「编辑」→
    用原生 setter 改正文（受控 textarea 直接 insertText 是无效的，dirty 不成立、保存按钮是灰的）→ 点保存；
    出图用的桩**跟着变**（`product-fixture.ts` 的 PATCH tp-1 分支把 `review_state` 从 approved 改成 pending）。
    图为 `shots/kfe/topic-resubmitted-1440.png`（**已看图**）：页头横幅「**已重新提交复审**，通过后其他人才能看到」+
    「正文改动已送回审核队列（服务端把审核态从「未通过」打回了「审核中」）」；动作条下回执
    「已保存 · 正文改动已重新提交审核」；正文里能看到刚补的那句；右栏赞助格显示「我的赞助」（作者本人）。
    路由级断言（`routes/topic.test.tsx` 的 B6 那条扩写）：保存后 `review-banner` 的 `data-state=pending`、
    `data-resubmitted=1`、文案含「已重新提交复审」。**证明会红**：把 `reviewResubmitted` 传死 `false` → 1 failed。
  - 下一步：L2 / J3 / J5 / J9 / L6 全等 K-BE 交契约（见上面「阻塞」一节）；
    L3 / L4 / L9 的文档**已写**进 `完全重构/界面施工-后端需求变动.md` 新增的 **§6.5**（三小节：
    AI 的两套提示词 + temperature（含「后端其实已齐、只差接线」的核对）、Issue 标签表、
    搜索高亮/历史/热门词的契约）。
  - 阻塞：L2 / J3 / J5 / J9 / L6 / L8 图片 —— 逐条写在上面「阻塞」一节。

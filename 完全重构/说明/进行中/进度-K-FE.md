# 进度 · K-FE（前端 + 打赏整块 + 私信图片）

> 作用域：`web/src/routes/**`、`web/src/devroom/pages/**`、`web/src/lib/api/**`、
> `web/src/ui/message/notice-chat.tsx`（点名授权）、`完全重构/UI与后端对齐.md`、本文件。
> **不碰**：`web/src/app/**`、`web/vite*.config.ts`、`web/package.json`、`forum/**`。
> 依据：`08-拍板记录.md`（用户拍板）+ `07-一次性完工交接单.md`（环境/协议/陷阱）。
> 基线：`pnpm typecheck && pnpm lint && npx vitest run` 绿（28 文件 / 146 用例）；`go test ./...` 34 包绿。

## 队列（照 08 的顺序，一条一提交）

- [x] L1 打赏/赞助整块前端接线（收款码上传/删除、打赏、我的打赏记录、收款码可见性、SponsorCard/RewardPanel 接真数据）
- [x] L2 首页「最热」排序（K-BE 交回契约后已接线：`sort=hot` 透传，游标由服务端算）
- [ ] L6 作者侧「打回修改」横幅 + 「查看最后过审版本」入口（**阻塞**：等 K-BE 加第四态 + 最后过审版本字段）
- [~] J3 踩的下发口径已按 K-BE 的 DTO 接上（不下发就看不见）；**把共享件 `ui/comment` 的 `dislikes` 改成可选要 Lead 授权**（冻结目录）
- [x] J5 Issue 检索/筛选：`?q=` 发后端 + `?sort=old`（最早创建）+ 提示文案改实话
- [x] J9 卡片用上 `cover_width`/`cover_height`（取图之前就判「太小」，不再闪糊图）
- [~] L8 私信：Unicode 表情不被正文链路破坏**已做**（含会红用例）；发图片**阻塞**（media 没有通用图片上传端点）+ 图片按钮已改成禁用+原因
- [x] L7 「已提交复审」反馈真页面验证（出图看过）+ G5 消息屏蔽词 WIP 标记
- [x] L3 / L4 / L9 只写文档（AI 两套提示词 + temperature、Issue 标签表、搜索高亮/历史/热门词）→ `界面施工-后端需求变动.md §6.5`
- [x] `UI与后端对齐.md` 定位改错（「暂时隐藏」→「待接线 / 待落地」，并把已做完的条目改成现状）

## 阻塞（跨人依赖，先写清不造 mock 兜底）

> 这一节是**交接给 K-BE 的部分**；每条都写清「要什么形状、拿到之后前端动哪个文件」。

- **L2**：需要 K-BE 的 `sort=hot` + 新游标键；字段名要照它交的变更表。
- **L6**：需要 `ck_topics_review_state` 加第四态（独立分类）与「最后过审版本」的存储/DTO 字段。
- **J3**：需要 K-BE 决定踩数（`dislike_count`）对谁下发；**接口不下发就不显示**，不在前端藏。
- **J5 / J9**：**已解除**（K-BE 已交付，前端已接线，见记录最后一条）。
## 收工状态（2026-10-14 17:30）

- 队列里**能做的都做完了**：L1（打赏整块）/ L2 / L6 / J5 / J9 / L7 / G5 / L8（表情那一半）/
  `UI与后端对齐.md` 定位订正 / L3·L4·L9 留文档。
- 剩下的是**三类**：① 等 K-BE 的端点（J6 的 `issues/kinds`）；② 等 media 的私信图片通道（L8 的发图）；
  ③ 要 Lead 授权才能动的冻结目录（J3 把 `ui/comment` 的 `dislikes` 改成可选）。
- 每一格的收工口径都是同一条：**会红的用例 + 看图**。
  最后一次全量：`npx vitest run` → `34 passed (34) / 175 passed (175)`；
  `pnpm lint` → `0 errors, 20 warnings`；`pnpm typecheck` 0 错。
- 出图脚本 `web/scripts/shoot-kfe.ts`（13 张，图在 `shots/kfe/`）**同一条连跑两次都 0 失败** ——
  桩按标签页隔离，L7 那条「真的保存一次」不会污染下一张。

- **J6 的类型下拉还写死四类**：`forum/internal/forum/issues.go:120` 有 `Service.IssueKinds`，
  但 `handler.go` **没有挂路由**（`GET /api/v1/issues/kinds` 不存在）—— 前端要「值域数据驱动」
  就必须先有这个只读端点。等 K-BE 挂上。
- **J3 的最后一格要 Lead 授权**：`web/src/ui/comment/**` 是冻结目录（不在我的文件作用域）。
  现在 `CommentData.dislikes` 是必填 `number`，所以「后端不下发」这一路只能传 0 —— 用户看到的
  结果是对的（那一格不显示数字），但**类型在说谎**：想让它如实，要把那个字段改成 `dislikes?: number`
  并把 `CommentActions` 的 `{dislikes || ''}` 改成「只有 number 才渲染」。
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

- [x] **收尾：出图脚本可重复 + G5 出图**（一条提交）。
  `shoot-kfe.ts` 加了两条：① G5 那条先切到 `icon-tab-settings` 再拍（DevRoom 11-profile 默认停在「帖子」，
  WIP 标记在「设置」页签里）；② `url` 以 `http` 开头时当绝对地址（DevRoom 走 `devroom.html` 另一个入口）。
  - 证据：**同一条脚本连跑两次都 0 失败**（第一次跑完会把 tp-1 的审核态改成 pending，第二次还能拍到
    「编辑 → 保存」那条链路 —— 这正是可重复性的证明）。G5 的图 `shots/kfe/devroom-g5-wip-1440.png`
    **已看图**：设置页签里那一行写着「**屏蔽词（WIP · 未实现）**  后端没有这张表、也没有端点，
    所以这一行现在不工作：加不进、也删不掉。」
    全量：`npx vitest run` → `34 passed (34) / 168 passed (168)`；`pnpm lint` → `0 errors, 19 warnings`；
    `pnpm typecheck` 我改的文件 0 错。
  - 下一步：**等 K-BE 交契约**（L2 / L6 / J3 / J5 / J9）与 media 的私信图片通道；交下来后照
    `完全重构/进行中/08-拍板记录.md` 对应那条直接接线，前端不需要新的论证。
  - 阻塞：同上。

---

- [x] **K-BE 交回契约后接线：L2 / J9 / J3 / J5**（一条提交；K-BE 的 `进度-K-BE.md` 把这几条标成「下一步：前端接线」）。
  ① **L2 最热**：`routes/home.tsx` 的 `SORTS` 加回第三档 `{key:'hot', label:'最热'}`，
     `lib/api/forum.ts` 的 `TopicFilter.sort` 值域补 `'hot'`。游标**不要前端管** —— K-BE 把它算好了
     （`pgsql.hotScoreSQL` + `forum/cursor.go` 的 `hotCursor`），前端只透传 `sort` 与 `cursor`。
  ② **J9 封面尺寸**：`devroom/pages/14-home/mock.ts` 的 `Topic` 加 `cover_width`/`cover_height`，
     `routes/_parts/mappers.ts` 从 `TopicCardDTO` 带过来，`topic-parts.tsx` 的 `TopicCover`
     改成**先看后端给的尺寸**再决定取不取图（原来只能先把小图拉下来、解码后量 `naturalWidth` 再回退，
     中间会闪一张糊图）。
  ③ **J3 踩的下发边界**：`lib/api/forum.ts` 与 `lib/api/issues.ts` 的 `dislike_count` 保持**可选**，
     `routes/issues.tsx` 写清「不下发 = 看不见」的口径（`CommentActions` 对 0 的渲染就是空串）。
  ④ **J5 检索与筛选**：`lib/api/issues.ts` 的 `IssueFilter` 补 `q`（后端标题+正文字面匹配），
     `IssueSort` 的注释补全值域（`parseIssueSort` 收 updated/created/new/old/comments），
     `lib/api/issues.ts` 与界面都支持 `sort=old`（升序那一档 = 真正的「最早创建」）；
     `routes/issues.tsx` 把自由词**发给后端**（原先只在前端过滤当前页 → 正文里的词与没翻到的页永远搜不到），
     并修掉那句已经过期的小字提示（它还写着「后端也没有反馈检索」）。
     顺带：`?q=` 与 `?sort=` 现在**从 URL 起步**（分享出去的地址能还原同一屏）。
  - 证据：`npx vitest run` → `34 passed (34) / 174 passed (174)`（新增 6 条：home 1 + 14-home 2 + issues 3）；
    `pnpm lint` → `0 errors, 20 warnings`（那条 error 是本次新增用例里的未用变量，已修）；
    `pnpm typecheck` 我改的文件 0 错。**四条新断言各证明过会红**：
    · J9：把「先看 cover_width」摘掉 → `方卡片：后端说封面太小…` 红（`expected <img …> to be null`）；
    · L2：把 `{key:'hot'}` 从 SORTS 去掉 → `排序点「最热」…` 红（找不到该按钮）；
    · J3：让桩**下发** `dislike_count: 7` → 该条红（`expected '7' to be ''`，证明这一格确实由下发决定）；
    · J5：把 `'old'` 从 `SORT_KEYS` 去掉 → 该条红。
    出图并**看图**：`shots/kfe/home-sort-hot-1440.png`（排序三档，**最热**高亮）、
    `shots/kfe/issues-search-1440.png`（检索框里是「隐藏」、排序下拉是**最早创建**、页头写「按 最早创建 排序」、
    小字提示已改成服务端筛选）。
  - 下一步：J6 的 `GET /api/v1/issues/kinds` 后端**还没有路由**（`Service.IssueKinds` 在，
    `handler.go` 里没有挂）—— 等它挂上前端的类型下拉只能是写死的四类。
  - 阻塞：J6 的 kinds 端点（见下）；L6 / L8 图片仍等（见「阻塞」一节）。

- [x] **L6 作者侧「打回修改」+「查看最后过审版本」**（K-BE 已交第四态 `revision_requested` 与 `revision_of`）。
  ① `devroom/pages/12-topic/review-state.tsx`：`ReviewState` 加第四态；**文案与操作都与「拒绝」分开**——
     标题「需要修改后再审」（蓝、Clock3 图标）+ 一句「这篇不是被拒绝：按下面的审核意见改一版，
     会重新进入审核队列」；操作说明也换成「存完就自动回到审核中（**不需要**另点一次提交）」，
     并且这一档**不渲染**「重新提交审核」那颗按钮（那是 rejected 的路径）。
  ② 新件 `devroom/pages/12-topic/revision-dialog.tsx` + `ReviewRevisionButton`（review-state.tsx）：
     「查看最后过审版本」入口，点开是只读弹层，正文走 `@/ui/comment` 的 `CommentBody`（与帖子正文同一渲染路径）。
     **为什么不就地换掉正文**：打回期间作者要接着改，正文区必须留给手上这一版（后端给的就是它），
     参照物放一个随手能关的弹层里才不打架。
  ③ `routes/topic.tsx` 的 `TopicWire` 补 `revision_of`，`toReview` 把它映射成 `review.revision`；
     线从 `main-column.tsx` 铺到 `topic-view.tsx`。
  - 证据：`npx vitest run` → `Test Files 34 passed (34) / Tests 175 passed (175)`；
    `pnpm lint` → `0 errors, 20 warnings`；`pnpm typecheck` 0 错。
    **证明会红**：把第四态的标题改回 `'未通过审核'`（= 把它当 rejected 处理）→
    `topic.test.tsx` 的 L6 那条红：`expected '未通过审核这篇不是被拒绝…' to contain '需要修改后再审'`。
    路由级用例（`routes/topic.test.tsx` 新增一条）：`data-state=revision_requested`、标题与「不是被拒绝」都在、
    理由显示、**没有** `topic-resubmit`，点 `topic-revision-view` 后弹层里有 `revision_of` 的正文。
    出图并**看图**：`shots/kfe/topic-revision-1440.png` —— 页头蓝框「需要修改后再审 / 这篇不是被拒绝…」，
    正文区仍是手上那一版，弹层「最后过审版本（通过于 2026年10月13日）」里是**上一次过审的正文**。
  - 下一步：队列第四档（`state=revision_requested`）归后台审核屏（K-ADMIN 那条线）。
  - 阻塞：无。

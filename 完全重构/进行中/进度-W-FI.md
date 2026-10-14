# 进度 · W-FI（交接单 §4.F 的 DevRoom 入口核实 + §4.I 的前端欠账 11 条）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **F**（F1/F2/F3）与 **I**（I1–I8）。
> **接手规则**：读完本文件 + `git log --oneline -8` 就能继续，不需要任何对话记录。
> 基线：master = `3c59b5f`，`cd web && pnpm typecheck && pnpm lint && npx vitest run` 全绿
> （typecheck 无输出 exit 0 / lint 18 warnings 0 errors / **28 文件 146 用例**）。
> 出图端口：**vite dev 5239、Chrome CDP 9243**（5199/5202 是共享入口，5229/9233 是 W-B 的，别占）。收工按 PID 关掉自己起的进程。
> 验证命令：**不跑 `pnpm check`**（它会 `pnpm build` 清空 dist，与并发施工互踩）；跑
> `pnpm typecheck && pnpm lint && npx vitest run`，出图/门禁单独跑。

## 作用域（交接单点名给我的）

- `web/src/ui/dev-entry.tsx`、`web/src/ui/comment/**`、`web/src/ui/rich/**`、`web/src/ui/message/notice-settings.tsx`
- `web/src/devroom/pages/14-home/states.tsx`、`web/src/devroom/pages/15-admin/admin-map.md`
- `web/src/routes/{home,board,me,profile}.tsx`、`web/src/lib/api/forum.ts`、`web/src/routes/_parts/mappers.ts`
- `web/scripts/check-bundle.ts`、`web/scripts/check-size.ts`（**超限时才碰**）
- `完全重构/开发必读.md`、本文件
- **不碰**：`web/src/app/**`、`web/vite*.config.ts`、`web/package.json`
- 越界但**交接单点名**：`web/src/routes/_parts/state.tsx`（I3 要把它与 14-home/states.tsx 收一份）、
  `web/src/devroom/pages/14-home/index.tsx`（I2 的第三份 GRID）、`web/src/devroom/pages/12-topic/topic.tsx`（I5 要删它那处局部类型）、
  `web/src/devroom/registry.ts`（I1 的欠账备注、I4 的登记，改的是备注/登记文字本身）。

## 步骤

- [x] 第 0 步：F1 核实「生产构建里真的没有 DevRoom 入口」—— **0 命中，不需要修**（临时扫描器已删，判据进了 F3 的门禁）
  - 做了什么：不带 `VITE_DEVROOM` 跑一次 `pnpm build`，用一次性扫描器 `web/.tmp-wfi-scan.cjs`（扫描器**自带自检**：
    needles 拿去扫已知含 devroom 的 `src/ui/dev-entry.tsx`，扫不到就 exit 2 拒绝出结论）扫 `dist/`。
  - 证据：`cd web && pnpm build` → `✓ built in 1.02s`（exit 0）；`node .tmp-wfi-scan.cjs` →
    `产物文件 109 个；产品侧 109 个，其中可扫 80 个（dist/devroom/** 是 DevRoom 自己的入口，按设计跳过）` /
    `自检：src/ui/dev-entry.tsx 命中 2/3 ["devroom","开发页面"]` /
    `产品产物里的 devroom 命中总数：0（期望 0）` → exit 0。
    三个 needle：`devroom`、`开发页面`（入口文案）、`开发者房间`。`dist/index.html` 里只有
    `assets/index-*.js` 与若干 modulepreload，**没有** `devroom` 链接。
  - 下一步：F3 把这套扫描折进 `web/scripts/check-bundle.ts`（新增 4) 段）。
  - 阻塞：无

- [x] 第 1 步：F3 把「DevRoom 只在 dev 制品里」做成门禁（`web/scripts/check-bundle.ts` 新增第 4) 段）
  - 做了什么：① 新增 `scanMarkers()`：逐文件逐处返回「文件 + 偏移 + 命中词 + 上下文」，命中时直接进 `problems`
    （不再只报一句「有命中」）；② 判据 **`devroom` / `开发页面` / `开发者房间`** 三个词，扫产品侧
    `.js/.html/.css/.json/.txt/.map`，跳过 `dist/devroom/**`（那是 DevRoom 自己的入口，按设计有它）；
    ③ 断言是**双向**的：产品侧带了这个链接就必须有 `dist/devroom/index.html` 兜住（否则线上死链），
    没开开关的生产构建必须 0 命中；④ 两个必须非零的对照：`src/ui/dev-entry.tsx` 源文件里扫得到、`dist/devroom/**` 里扫得到
    —— 扫描器坏了/路径变了/字符串被拆开时也要红，而不是打印一个漂亮的 0。
  - 证据：**会红**（`$env:VITE_DEVROOM='1'; pnpm build; node scripts/check-bundle.ts`，exit 1，2 条新增）→
    `✗ 产品产物指向 DevRoom，但 dist/devroom/ 不存在（线上死链；这次构建开过 VITE_DEVROOM？）dist/assets/index-dd3c5ucU.js:286034 「devroom」 …href:N(\`devroom/\`)…` 与
    `…:286272 「开发页面」 …children:\`开发页面（临时）\`…`；
    **会绿**（`Remove-Item Env:\VITE_DEVROOM; pnpm build; node scripts/check-bundle.ts`）→ 新检查 0 命中，
    只剩两条与本次改动无关的基线条目（裸 dist 没有 `dist/devroom/index.html`）；
    **完整 dev 制品会绿**（模拟 `pack-dev.ts`：VITE_DEVROOM=1 构建 + `pnpm preview:build` + 并入 `dist/devroom/`）→
    `产物自洽检查通过：入口齐、20 个 DevRoom 页面在产物里、29 个资源都在、dev 制品：产品侧 DevRoom 入口 2 处，dist/devroom/** 自己的 14 处`，exit 0。
    **F1 的关键实测**：开关真的接在打包器上 —— 不带变量 `index-BPHrUDIx.js`（chunk 里连 `bottom-4 right-4` 类名都搜不到），
    带 `VITE_DEVROOM=1` 变成 `index-dd3c5ucU.js` 且多了 `var ll=!0;function ul(){return ll?…}`。
  - 下一步：F2 出图（端口 5239，dev 制品里入口是右下角固定的「开发页面（临时）」胶囊）。1440 与 390 两个视口各一张，
    图里要能证明拍的是当前源码（往 DOM 插可见标记）。若判定它遮挡内容/不显眼，改 `web/src/ui/dev-entry.tsx`
    的 `className`/`位置`/`文案`，重出图（**本文件就是给它准备的**）。
  - 阻塞：无（另有一处**顺带发现**，见「第 2 步」）

- [x] 第 2 步：修 `check-bundle.ts` 里一条**从来没生效过**的检查（它现在会拦住打包，必须先修）
  - 做了什么：第 2) 段的页面 key 正则原本匹配 `'01-interactive': {` 这种**对象字面量**写法，而 `app.tsx` 早已改成
    `{ key: '01-interactive', title, el }` 的数组 → 一直解析出 **0 个 key**，于是 `length>0` 那条断言从没红过、
    逐页存在性检查一个都没跑（"永远通过的检查"）。改成 `/key:\s*'([0-9]{2}-[a-z0-9-]+)'/g`。
    这不是"顺手优化"：一是 `pack-dev.ts` 第 4 步会调它，留着它红就没法打包；二是 F3 的对照就长在这段里。
  - 证据：**旧行为**：`node scripts/check-bundle.ts`（完整 dev 制品）→ `✗ 从 app.tsx 里没解析出任何页面 key（注册写法变了？）` exit 1；
    `git show HEAD:web/src/devroom/app.tsx | Select-String "^\s+\{ key:"` → `{ key: '00-showroom', … }`（提交里的写法就是数组）。
    **新行为**：`20 个 DevRoom 页面在产物里` exit 0。**这条复活后的检查会红**：临时往 `app.tsx` 插
    `{ key: '99-wfi-probe', … }` → `✗ DevRoom 页面 99-wfi-probe 不在产物里（构建顺序错了或忘了 build）` exit 1，
    随后 `git checkout -- src/devroom/app.tsx` 恢复 → exit 0。
  - 下一步：F2 出图（同第 1 步的下一步）。
  - 阻塞：无

- [x] 第 3 步：F2 dev 里的入口显眼可点、不遮挡内容（1440 / 390 出图）—— **发现并修掉一处遮挡**
  - 做了什么：出图看实物。图上量到 390 视口下入口是 **144×40 的胶囊、落在 [230,844]**，而页脚
    （`app/shell.tsx:123-129`，`py-6` + 一行字，高 73px）正是 **y=827 起** —— 它压在页脚
    「SC2clud · 星际争霸战役社区」上。浮层不给页面留位，只能让自己别盖住东西：给 `dev-entry.tsx` 的 `className`
    加 `max-sm:bottom-20 max-sm:right-3 max-sm:px-3 max-sm:py-2 max-sm:text-xs`（**没有新令牌、没有手写控件**）。
    出图台：`shots/wfi-shot.mjs`（**新文件**，端口 5239/9243 是 W-FI 的编号；服务的是 `web/dist`
    的 dev 制品 —— 产品页上才有这个入口，preview 入口不渲染 `DevEntry`）。
  - 证据：`node shots/wfi-shot.mjs entry`（先 `VITE_DEVROOM=1 pnpm build` + DevRoom 并入 `dist/devroom/`）→
    修前 390：`rect:[230,844,144,40]`（页脚自 827 起，压住站点名）；
    修后 390：`rect:[258,788,120,32] insideViewport:true hitTest:true`（120×32 ≥ 最小点按尺寸，且整块在页脚之上）；
    1440：`rect:[1280,844,144,40] hitTest:true`（页脚文字居中，不重叠）。
    `hitTest`/`hitTag` 是 `document.elementFromPoint` 的实测值，为 `A.fixed bottom-4 right-4 z-50 …` 本身
    —— 证明**可点、没被盖住**，不是"看着像能点"。控制台问题：无。
    图（gitignore，存在本机）：`shots/wfi/f2-entry-home.png`（1440）、`f2-entry-home-390.png`（390，修后）、
    `f2-entry-home-1440-strip.png`（右下角放大条，看得清压没压页脚）。
  - 下一步：I1 把 `inline={false}` 收口（`src/ui/comment/comment-actions.tsx`、`src/ui/rich/markdown-editor.tsx`、
    `src/ui/rich/image-uploader.tsx`、`src/ui/message/notice-settings.tsx` + `11-profile` 的「关注 / 发私信」），
    出图台用 `node shots/wfi-shot.mjs inline`（走 `/devroom/?page=08-comments|09-rich|10-messages`）。
  - 阻塞：无

- [x] 第 4 步：I1 `inline={false}` 收口 —— **登记表过期了：真正缺的只有 3 处**
  - 做了什么：逐处核 registry 点的那五个地方。**comment-actions（3 个）/ markdown-editor（7 个工具栏）/
    image-uploader（添加图片 + 移除缩略图）/ 11-profile 的「关注 / 发私信」当时都已经写过** `inline={false}`；
    真正缺的是：① `src/ui/message/notice-settings.tsx` 的「添加」；② `src/ui/rich/image-uploader.tsx`
    **头像态**的「移除」（它**只有文字没图标**，但 Ring 是 `isInline = inline ?? text ?? !!icon`，照样走 inline）；
    ③ `src/ui/nav/icon-tabs.tsx` 的三个页签（图标是**子元素**不是 icon prop → isInline 拿不到它，
    但 `.ring-button-inline` 照样生效，与同一个 className 里的 `inline-flex` 打架）。三处都补了 `inline={false}`
    （前两处另给 `height={ControlsHeight.S}` 对齐旁边的按钮）。`registry.ts` 那条「已知欠账」改成实测结论。
  - 证据：**会红**（临时把 notice-settings 的 `inline={false}` 去掉、重建、量同一颗按钮）→
    `measure [data-testid=setting-add] -> {"display":"inline","pad":"0px","w":90,"cls":"…ring-button-inline…"}`；
    **绿**（加回去）→ `{"display":"block","pad":"4px 16px","w":112,"cls":"…ring-button-block…"}`。
    同一轮量到 `[data-testid=icon-tab-posts]` → `{"display":"block","pad":"4px 16px","cls":"…ring-button-block…"}`。
    页面：`/devroom/?page=11-profile` 点「设置」档（`node shots/wfi-shot.mjs inline`）。图：`shots/wfi/i1-profile-settings.png`
    （第 4 档页签与「+ 添加屏蔽词」都是真按钮，不是蓝字链接）。
    `pnpm typecheck` exit 0；`pnpm lint` 19 warnings 0 errors（全是 Fast-refresh/exhaustive-deps 旧账）；
    `npx vitest run` → **28 文件 148 用例全过**（基线 146，另 2 条是别人的在途改动带来的）。
  - 下一步：I2/I3 去重（`GRID` 三处 → 一处；`Empty` 与 `EmptyState` → 一份）。
  - 阻塞：`web/src/devroom/registry.ts` 有**别人在途改动**（`15-admin/screens/users.tsx`、`routes/admin.tsx` 等同时被改），
    edit 工具连报两次「file changed since it was read」。我只改了自己那一行**备注文字**，如果对方在我之后覆盖，
    这条备注会丢 —— 由 Lead 合并时确认（不影响任何门禁）。

- [ ] I1（已完成，见上）
- [ ] I1 `inline={false}` 统一收口（comment-actions / markdown-editor / image-uploader / notice-settings + 11-profile 的「关注/发私信」）
- [x] I2 `GRID` 三处收一处 —— 见下面「第 5 步」
- [x] I3 空态两份收一份（新建 `src/ui/state/empty.tsx`）—— 见「第 5 步」
- [x] I4 `CompactTopicRow` **正式登记**（不统一到 topic-row，理由在「第 5 步」）
- [x] I5 `Topic` 改用 DTO 真名，三处 `as` 全清 —— 见「第 5 步」
- [x] I7 `mappers.ts` 的过期注释删掉 —— 见「第 5 步」
- [x] I8 `admin-map.md` 13.10 改成实话 + 小计改口径 —— 见「第 5 步」
- [x] B7 **不换** `IconTabs`，理由进了 `设计对齐.md` §4 —— 见「第 6 步」

- [x] 第 5 步：I2/I3/I4/I5/I7/I8 六条小账一次收口
  - 做了什么：**I2** `GRID` 三处逐字相同 → 收进 `routes/_parts/state.tsx`（首页/分区页/房间都用它；原先靠注释互相提醒「要与另一页一致」，那种约定没有落点）；
    **I3** 空态两份 → 新建 `src/ui/state/empty.tsx`（两边都不欠对方人情，谁都能 import），`_parts/state.tsx` 改成转出（8 个产品路由 import 一行没动），
    `14-home/states.tsx` 那份 `EmptyState` 删掉、两个调用点改用 `Empty`；
    **I4** `CompactTopicRow` 正式登记（与 `square-topic-card` 同款「待提升为 src/ui」的例外），并把 `topic-row` 条目的口径改成「全站**主题行**的唯一实现，但它不是信息流本身」；
    **I5** `lib/api/forum.ts` 的 `Topic` 改用 DTO 真名（`cover_hash` / `featured` / `avatar_hash` / `avatar_small_hash`），删 `mappers.ts` 的 `TopicCardRaw`、`topic.tsx` 的 `TopicWire` 里两行、`issues.tsx` 的 `as`；
    夹具跟着改真名（`app.test.tsx` / `compose.test.tsx` / `product-fixture.ts` 的 `featured_at` / `cover` / `avatar`）；
    **I7** `mappers.ts` 那句「excerpt 是列表项缺的字段」删掉（`TopicCardDTO.Excerpt` 早就有，`forum/internal/forum/dto.go:45`）；
    **I8** `admin-map.md` 13.10 从「**不做**：方案没有 AI 审核模块」改成实话（d7 已落地、四个端点、`nav.ts`/`index.tsx`/`routes/admin.tsx` 都挂着 ai 屏），小计从「做 12 / 不做 2」改成「做 13 / 不做 1」+ 一句口径提醒。
  - 证据：I5 的效果是**会红**的证明：删掉局部类型后 `tsc` 立刻炸出真名不匹配（`Property 'avatar' does not exist on type 'TopicAuthorSummary'`、`'raw' is declared but never read`、`Type 'string | null' is not assignable to type 'string'`），
    逐个改完 → `pnpm typecheck` 无输出。测试：`npx vitest run src/routes/topic.test.ts src/routes/topic.test.tsx src/devroom/pages/14-home` → **3 文件 19 用例全过**
    （`topic.test.ts` 里就有「`featured` 为 true」那条，正是 I5 的回归点）。出图：`shots/wfi/i23-devroom-home.png` —— 14-home 的卡片栅格仍是 4 列、空态仍是虚线框 +「这个分区还没有帖子」，
    I2/I3 是**纯结构搬家**（类名与结构逐字没动），图与前一轮同级。
  - 下一步：B7（第 6 步）。
  - 阻塞：`pnpm gate:size` 现在红在 `routes/admin-screens.tsx` **690 行未登记** —— 那是**别人的在途文件**（不在我的作用域，我不动它）；`routes/messages.tsx` 642 行已登记。
    我名下最大的两个是 `routes/issues.tsx` 493 行、`routes/topic.tsx` 463 行，都没超 500。

- [x] 第 6 步：B7 `me.tsx` 换不换 `IconTabs` —— **不换**，理由写进 `完全重构/进行中/设计对齐.md` §4（新增一节）
  - 做了什么：先看实物再定。生产预览入口 `product.html` 只挂 5 条路由（`/`、`messages`、`issues`、`t/:id`、`notifications`），**`/me` 出不了图**；
    所以两边实物是：`routes/me.tsx:67-81` 的两个 ghost Button（`height S`、**没有图标**、标签「我的收藏 / 我的举报」）
    与 `shots/wfi/i1-profile-settings.png` / `b7-icon-tabs-1440.png` 里的真 `IconTabs`。三条不换的理由，第一条是**实测**：
    ① `IconTabs` 的 `h-12`（48px 口袋高度）被 Ring 未分层的 CSS 压住 —— 实测 `icon-tab-posts` 是 **28×111 / font 14px**，而 `/me` 现在是 24px，
    所以「套上去只是更大更响」这个前设不成立（它甚至更矮），换了也换不来视觉收益；
    ② 契约对不上：`IconTabs` 的 `items[].icon` 必填、`count` 可选，而收藏/举报**没有图标语义**，条数只有当前分页的 `items.length`（要显示就得编个假总数）；
    ③ 语义不同：`registry.ts` 的 `icon-tabs` 条目自己写着是「大号分区导航」（个人主页），`/me` 是两个平级列表的切换，且 `routes/profile.tsx` 已在用 `IconTabs`，并存无冲突。
  - 证据：`node shots/wfi-shot.mjs b7` → `b7-me-1440` 的 bodyText 与首页**逐字相同**（说明 `product.html` 没有 `/me` 这条路由，那张图**不作数**，已在设计对齐里写明）；
    `b7-icon-tabs-1440.png` / `b7-icon-tabs-390.png` 出的是 11-profile 的 `IconTabs` 实物；高度/字号来自 `node shots/wfi-shot.mjs inline` 的 `measure [data-testid=icon-tab-posts]`。
  - 下一步：交接单 §4.I 里**我名下的**条目已全部落地（I1–I5、I7、I8 + B7）；I6/I9/I10/I11 不在这次派单里。
  - 阻塞：无

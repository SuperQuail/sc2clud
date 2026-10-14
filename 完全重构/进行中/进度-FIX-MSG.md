# FIX-MSG（D10 消息中心 / D11 搜索）进度

> 文件作用域：`web/src/devroom/pages/10-messages/**`、`web/src/devroom/pages/19-search/**`、
> `web/src/routes/messages.tsx`、`web/src/ui/nav/**`、`web/src/ui/message/notice-nav.tsx`。

- [x] D10 第一刀：信息中心抽成 **prop 驱动的 View**，产品路由退化成薄宿主，档位真源收成 URL 一处
  - 证据：新增 `10-messages/notice-center-view.tsx`（View，`notice-logic.tsx` 定数据端口 NoticeSources）+
    `mock-data.ts`（房间的假数据与本地写）；`routes/messages.tsx` 645 → 224 行，只剩取数 / 档位 / 页头 / 两个路由入口。
    两条断言都**先红后绿**：
    ① 房间页 `10-messages/index.test.tsx` 在旧代码下红在第一条
    `AssertionError: expected '?page=10-messages' to contain 'panel=messages'`（点导航不写 URL）；
    ② 产品页 `routes/messages.test.tsx` 的三处一致用例在旧代码下红在
    `messages.test.tsx:231 expected false to be true` —— **实测复现了 D10**：点「消息设置」后地址栏是
    `?panel=settings`，而选中态还停在「回复我的」（`NoticeCenter` 的 panel 来自 prop、kind 来自 URL，
    两套真源）。收成 URL 一处后两条都绿：`npx vitest run src/routes/messages.test.tsx src/devroom/pages/10-messages`
    → `Tests 11 passed`。
  - 下一步：D11 —— 在 `web/src/ui/nav/` 新增 `header-search.tsx`（顶栏「展开搜索栏 + 就地出结果」的可复用件），
    先在 DevRoom 出图验证，再把「shell.tsx 要改的那一行」写进阻塞。
  - 阻塞：（1）`web/src/app/shell.tsx` 是 Lead 专属 —— 「搜索」那一颗现在是
    `<Button ... href={appPath('')}>搜索</Button>`（第 39 行），要改成挂 `HeaderSearch`，**我不能动**，见下一节。
    （2）`web/src/preview/product-fixture.ts` 只有 `?route=` 一个路由维度、没有 query，产品页出图时打不到
    `?panel=settings` / `?kind=like` 这类非默认档（DevRoom 侧的深链能出图）。
    （3）`web/src/devroom/main.tsx` 挂 `Providers` 是我这屏带进来的（View 吃 react-query）；
    该文件虽不在我的作用域清单里，但改的是 DevRoom 自己的入口，已在本提交里说明。

- [x] D10 第二刀：页头也收成同一个件 + 三个写动作接进房间 + **同源断言**（骨架逐字比）
  - 证据：新增 `notice-head.tsx`（两个入口共用，文案在 `notice-logic.tsx` 的 `noticeHead()`）；
    房间接上「标为已读 / 删除 / 不再通知此类」（真站那三条端点的对应物，`mock-data.ts` 的
    `roomMarkNoticesRead`/`roomDeleteNotice`/`roomMuteKind`）；
    新增 `same-source.test.tsx`：**同一档、同一批数据下，房间页与产品 View 的 DOM 骨架（标签 + 决定版面的 class）
    逐字相同**（两侧各一个容器，先等内容出现再比）。它会红 —— 写这条时实测两次：
    ① 两侧共用一个 document.body 容器时，"产品侧"等到的其实是**房间的节点**（自己跟自己比）；
    ② 数据端口不给写动作时，View 会按「这一档没有落库」去掉动作槽位 → 房间比产品多出
    「标为已读 / 删除」两格；给上就一致（说明这条断言真的在比东西）。
    出图：`shots/fixmsg/dr-msg-like2-900.png`（房间）与 `pr-msg-notices-900.png`（产品，真壳 + 桩数据）——
    同一档的标题「通知中心」、描述、导航选中态、行内容与动作槽位一致，差别只有数据。
    `npx vitest run src/devroom/pages/10-messages src/routes/messages.test.tsx` → `Tests 12 passed`。
  - 下一步：D11 顶栏搜索 —— 见下一条（已完成，剩 Lead 的一行接线）。
  - 阻塞：同第一节的三条（shell.tsx 专属 / 产品出图入口没有 query 维度 / devroom/main.tsx 挂了 Providers）；
    D11 的那一行接线是本条清单最后一件不属于我的事。

- [x] D11 顶栏搜索：**不换页、顶部就地展开并聚焦**的可复用件（接线那一行留给 Lead）
  - 证据：新增 `web/src/ui/nav/header-search.tsx`（自包含的开合浮层：再点一次 / 点外面 / Esc 收起，
    **刻意没有 href** ——旧实现那颗是 `href={appPath('')}` 的链接，点了跳回首页）
    与 `header-search-results.tsx`（结果区 = 首页那一块 `SearchPanel`，**同一个件**；懒加载，因为
    SearchPanel 为 Tabs 静态拖进 react-virtualized 一条链 53 KB gzip，见 routes/home.tsx 的注释）；
    `header-search.test.tsx` 2 条：①「不导航 + 就地展开 + 焦点进输入框」（`activeElement` 就是输入框）；
    ② 打开搜索**不发任何 `/api/v1/search` 请求**（提交才发）。实测红过两次：先红在
    「点开找不到输入框」（Ring 的 Input 不吃 autoFocus，改成结果区挂载后自己 focus），
    再红在「焦点不在输入框」（`expected <body> to be <input>`），修完两条绿。
    出图：`shots/fixmsg/dr-search-open-900.png`（展开态）与 `cdp-3-results.png`
    （**键入「战役」回车后结果就地出现**：帖子档 5 条，地址栏没变、页面没跳）——
    为此加了 `web/scripts/cdp-shot.ts`（CDP + Node 自带 WebSocket，能 click / type / key / shot；
    一次性 `--screenshot` 拍不到「键入之后」的状态，而 D11 的验收正是那一步）。
    `npx vitest run src/ui/nav src/devroom/pages/19-search src/devroom/pages/10-messages src/routes/messages.test.tsx`
    → `Test Files 7 passed / Tests 25 passed`；`gate:ui` / `gate:controls`（48 件）/ `gate:urls` 全绿。
  - 下一步：**Lead 接线**（见下面的阻塞，一行）→ 然后我出产品页对照图（顶栏那一颗点开的样子）。
  - 阻塞：**`web/src/app/shell.tsx` 第 39 行**（Lead 专属，我不改）现在是：
    ```
    {/* 搜索内嵌在首页（用户要求不单独开页面），所以这个按钮只是把人带到首页的搜索框旁 */}
    <Button ghost inline={false} height={ControlsHeight.S} href={appPath('')} icon={icon16(Search)}>
      搜索
    </Button>
    ```
    改成一行即可（`Search` 图标与 `appPath` 若不再被该文件其它地方使用，顺手删 import；
    `HeaderSearch` 已登记进 registry，`gate:controls` 放行）：
    ```
    <HeaderSearch />
    ```
    接线后建议把「首页那一条」保留（首页内嵌搜索不动，用户明确说过保持现状）。

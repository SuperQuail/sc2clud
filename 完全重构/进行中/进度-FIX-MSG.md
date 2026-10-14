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
  - 下一步：D11 顶栏搜索 —— 在 `web/src/ui/nav/` 新增可复用的「就地展开搜索栏」件，DevRoom 出图，
    产品接线是 `shell.tsx` 那一行（Lead 专属，见阻塞）。
  - 阻塞：同第一节的三条（shell.tsx 专属 / 产品出图入口没有 query 维度 / devroom/main.tsx 挂了 Providers）。

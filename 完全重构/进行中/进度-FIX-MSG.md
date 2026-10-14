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
    先在 DevRoom 出图验证，再把「shell.tsx 要改的那一行」写进阻塞。另需给 D10 补 DevRoom 与产品页的出图对照。
  - 阻塞：（1）`web/src/app/shell.tsx` 是 Lead 专属 —— 「搜索」那一颗现在是
    `<Button ... href={appPath('')}>搜索</Button>`（第 39 行），要改成挂 `HeaderSearch`，**我不能动**，见下一节。
    （2）`web/src/preview/product-fixture.ts` 只有 `?route=` 一个路由维度、没有 query，产品页出图时打不到
    `?panel=settings` / `?kind=like` 这类非默认档（DevRoom 侧的深链能出图）。
    （3）`web/src/devroom/main.tsx` 挂 `Providers` 是我这屏带进来的（View 吃 react-query）；
    该文件虽不在我的作用域清单里，但改的是 DevRoom 自己的入口，已在本提交里说明。

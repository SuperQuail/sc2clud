# 进度 · FIX-COPY（issue 种类文案 + 用户可见处裸串）

> 作用域：`web/src/devroom/pages/12-topic/_task/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/issues.tsx`、`web/src/devroom/pages/12-topic/topic-view.tsx`（只改文案相关行）、本文件。
> 依据：`10-dev排查-缺陷清单.md §1c` 第三轮拍板（用户原话「汇报 bug 按钮就是汇报 bug，而不是什么奇怪的词」）。
> **迁移号：本包不占号** —— 纯前端文案/文本，无 schema 变更（0031 起留给真要迁移的包）。

- [x] 步骤1：种类文案真源单点改「报个 Bug」→「汇报 Bug」，**所有**出现处一起改（含测试断言）
  - 证据：
    · **先证明断言会红**：只改真源 `12-topic/_task/types.ts:29`（先不动测试）→
      `npx vitest run src/devroom/pages/13-issue/index.test.tsx src/devroom/pages/12-topic/topic-view.test.tsx src/routes/issues.test.tsx src/routes/issues.new-issue.test.tsx`
      → `Test Files 4 failed (4) | Tests 5 failed | 22 passed`，5 条全部是
      `Unable to find role="button" and name /^报个 Bug/`（`topic-view.test.tsx` 那条是 `role="link"`）——
      证明这些断言**确实盯着这串文案**，不是「永远通过」的检查。
    · 改完 8 处（真源 1 + 注释/出图页 2 + 断言 4 个文件 5 处；`issue-kind-button.tsx` 的 title/aria-label
      与产品页按钮文字都从真源 `ISSUE_KIND_META` 派生，**没有第二份词表**）→ 同一命令
      `Test Files 4 passed (4) | Tests 27 passed`。
    · `pnpm typecheck` 退出码 0；`pnpm lint` → `17 problems (0 errors, 17 warnings)`（全是仓库既有 warning）。
    · 全仓 `报个 Bug` 剩余命中只有**历史记录**：`进度-W3.md` 两条旧记录、`10-dev排查-缺陷清单.md §1c`
      引用改动前原文的表格 —— 历史不改写，故保留（已逐条确认无代码/无断言残留）。
  - 下一步：步骤2 —— 裸串排查与收口：`13-issue/issue-filter-bar.tsx:127-135` 的「限定词」语法提示
    （用户截图里 `|difficulty|other·label:` 的形状就是它）、`13-issue/index.tsx:283` 与
    `routes/issues.tsx:420` 的 `状态开关（Open / Closed）` + `复用 @/ui/comment`、
    `routes/issues.tsx:337-339` 的 Markdown `**` 字面量、`routes/issues.tsx:271` 的 `forum.not_resource`。
  - 阻塞：无

- [x] 步骤2：用户可见处的裸枚举/语法串排查与收口（**含用户截图里 `|difficulty|other·label:` 那个形状**）
  - 结论（**保留 + 说清**，不是删掉）：那个形状就是 `13-issue/issue-filter-bar.tsx` 检索条下的一行提示
    `限定词：is:open|closed · kind:bug|feature|difficulty|other · label:标签 · author:handle`。
    **它是给用户看的**：检索框真的实现了 GitHub 那套限定词（`query.ts` 解析 `is:/kind:/label:/author:`），
    而且旁边就靠它解释「没识别：xxx」那句回执；删了这行等于把一个真功能变成猜谜。
    但它当时**没自报家门**（「限定词」是行话），所以读起来就像漏出来的枚举 —— 改法是把话说清：
    `限定词：` → `检索语法：`。同一条提示里的样例 `author:demo-marine` 是**假名单**（产品页上并不存在这个人），
    一并从 placeholder 去掉（`author:handle` 的写法在那行提示里照旧有）。
  - 同一轮**真的该收口**的裸串（都改了，且都是「内部串漏进用户界面」）：
    · `13-issue/issue-detail.tsx:91-92`：状态开关的可见文字是 `待处理 Open` / `已关闭 Closed`，help 里还有「关掉即 Closed」
      —— 裸枚举，改走 `ISSUE_STATUS_LABEL`（开启中 / 已关闭），与上面那枚状态药丸、页签同一份文案；
    · `13-issue/index.tsx:283` 与 `routes/issues.tsx:420`（详情空态那一句）：`状态开关（Open / Closed）` + `复用 @/ui/comment 的评论区`
      —— 裸枚举 + **源码路径**，改成 `（{ISSUE_STATUS_LABEL.open} / {ISSUE_STATUS_LABEL.closed}）` + 「以及评论区」；
    · `routes/issues.tsx:337-339`：`**服务端筛选**`、`**还没翻到的页也搜得到**` —— **Markdown 星号字面量**直接显示给用户
      （外加「本项目还没有标签表」这种内部黑话），去掉星号与黑话；
    · `routes/issues.tsx:271`：回执里写着后端错误码 `forum.not_resource` 与 `?topic=<帖子 id>`，改成一句人话；
    · `routes/issues.tsx:293`：同类回执里的 `（没有 ?topic=）` 一并去掉；
    · `routes/issues.tsx:375`：空态提示里的查询参数名 `author= / assignee=me` 改成「要按登录身份筛」。
  - 证据（**先证明断言会红**）：先只加两条守卫断言（`13-issue/index.test.tsx` 整页 textContent 不含 `@/`、`\bOpen\b`、`\bClosed\b`
    且含「检索语法」；`routes/issues.test.tsx` 不含 `**`、`forum.`、`author=` 与回执里没有 `forum.`/`?topic=`）→
    `npx vitest run src/devroom/pages/13-issue/index.test.tsx src/routes/issues.test.tsx`
    → `Test Files 2 failed (2) | Tests 3 failed | 13 passed`，红的三条正是：
    `expected '帖子内容问题反馈汇报 Bug…限定词：is:open…' not to contain '**'`、
    `… not to match /\bOpen\b/`、`expected '提反馈要先登录。知道了' to contain '帖子页'`。
    改完 → 同一命令 `Test Files 2 passed (2) | Tests 16 passed (16)`。
  - 全量：`pnpm typecheck` 退出码 0；`pnpm lint` `17 problems (0 errors, 17 warnings)`；
    `npx vitest run` → `Test Files 2 failed | 49 passed (51) / Tests 4 failed | 248 passed (252)`，
    红的两个文件都**不是本包的**：`routes/profile.test.tsx`（FIX-TITLE 在途，`Found multiple elements with the role "link" and name "账号设置"`）、
    `routes/home.test.tsx` 3 条（**单独跑绿**：`npx vitest run src/routes/home.test.tsx` 过；
    与我这三个文件同跑也绿 `3 passed (3) | 21 passed` → 是全量并发下的抖动，与 FIX-TOPIC 记的 10-messages 同一形态）。
  - 下一步：步骤3 出图 —— DevRoom `devroom.html` 的 13-issue 页 + 产品 `product.html?route=/issues`（1440 与 390），两张都要看。
  - 阻塞：无

- [x] 步骤3：出图 —— DevRoom 13-issue 与产品 `/issues`，1440 与 390，**两张主图都看过**
  - 证据（命令 + 输出关键行）：
    · 起自己的预览服务：`cd web && node node_modules/vite/bin/vite.js --config vite.preview.config.ts --port 5301 --strictPort`
      （5301 是我这一轮的号；收工已按端口属主 `Stop-Process` 掉该 PID，复查 `port 5301 released`）。
    · 出图脚本 `shots/fix-copy/shot.mjs`（`/shots/` 在 .gitignore 里 —— 与 FIX-TOPIC 的 `shots/fix-topic/overlap.mjs` 同一处置），
      `node shots/fix-copy/shot.mjs` → **失败 0 张**：
      ```
      OK devroom-13-issue-1440  1440x1150  字 1375  「汇报 Bug」x4  检索语法=true  标记=—
      OK devroom-13-issue-390   390x1100   字 1375  「汇报 Bug」x4  检索语法=true  标记=—
      OK product-issues-1440    1440x1150  字 504   「汇报 Bug」x2  检索语法=true  标记=MARKER-PRODUCT-LOGIN /issues?topic=tp-1
      OK product-issues-390     390x1100   字 504   「汇报 Bug」x2  检索语法=true  标记=MARKER-PRODUCT-LOGIN /issues?topic=tp-1
      OK product-issues-search-1440 1440x1150 字 609 「汇报 Bug」x2  检索语法=true  标记=MARKER-PRODUCT-LOGIN /issues?topic=tp-1
      ```
      每张图都**顺带跑了同一组断言**（不是只截图）：页面上有「汇报 Bug」、没有旧文案「报个 Bug」、
      有「检索语法」那一行，且用户可见文字里没有 `@/ui/` `forum.` `author=` `Open / Closed` `待处理 Open` `?topic=`、没有 `**` 字面量；
      产品页还要求那块 `MARKER-PRODUCT-LOGIN /issues?topic=tp-1` 在位（§5.4：读得到它才证明拍的是当前源码）。
      （写脚本时踩到一次：`?topic=` 一直报红，根因是**预览浮层自己**写着 route —— 已先把它从可见文字里摘掉再判：浮层不是用户会看到的东西。）
    · 我看到的（两张主图）：DevRoom 13-issue 四个入口是「汇报 Bug / 功能建议 / 难度建议 / 其他反馈」，
      检索框下那行是「**检索语法**：is:open|closed · kind:bug|feature|difficulty|other · label:标签 · author:handle（…）」，
      详情里状态开关写「开启中 / 当前：开启中（关掉就是已关闭）」；产品 `/issues?topic=tp-1` 与它**同一份版面**
      （真壳 + 真顶栏 + 左下角 MARKER），空态那句已经是「状态开关（开启中 / 已关闭）、以及评论区」。
      `product-issues-search-1440`（敲了 is:open）看到清理后的那段：「自由词与 is: / kind: / author: 都发给服务端筛 …（本站还没有标签功能）」。
  - 收工验证：`pnpm typecheck` 0；`pnpm lint` 0 errors（17 warnings，仓库既有）；
    `npx vitest run` → **`Test Files 51 passed (51) | Tests 252 passed (252)`**（前一次同一命令的 4 条红是别人的在途文件
    `routes/profile.test.tsx`（FIX-TITLE）与 `routes/home.test.tsx` 的并发抖动 —— 现在两个文件都归零，本条已复测）。
  - 顺带记一条**不属于本包**的观察（没改）：390 视口下那四个入口仍是 `grid-cols-4`，
    文字被截成「汇报 B / 功能建 / 难度建」，两个入口**一模一样地截**（同源，不是分叉）——
    要动版式才谈得上修，属 FIX-TOPIC/设计对齐的范围。
  - 下一步：无（本包三条任务已完）。
  - 阻塞：无

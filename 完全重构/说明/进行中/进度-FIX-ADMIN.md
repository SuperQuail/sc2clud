# 进度 · FIX-ADMIN（D12 / D13 / D14 / D15 —— 后台与 DevRoom 入口）

> 任务书：`完全重构/进行中/10-dev排查-缺陷清单.md`（第 0 节的**同源要求**与第 2 节派发分组表里属于 FIX-ADMIN 的四条）。
> 环境与协议：`完全重构/进行中/07-一次性完工交接单.md` §1/§2/§3。基线：master = `d9a865e`。
> 出图端口：静态服务 **5291/5292、CDP 9291/9292**（出图台 `shots/fixadmin-shot.mjs`，本包自用，收工按 PID 关）。
> 验证命令：**不跑 `pnpm check`**（它会 build 清 dist，与并发施工互踩）；跑 `pnpm typecheck && pnpm lint && npx vitest run`。
> 作用域：`web/src/devroom/pages/15-admin/**`、`web/src/routes/admin/**`、`web/src/ui/dev-entry.tsx`、
> `web/scripts/check-bundle.ts`（只加门禁）、`完全重构/进行中/进度-FIX-ADMIN.md`。
> **不碰** Lead 专属：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`。

- [x] 第 1 步：D15 先查清事实（入口是被摇掉还是看不见）→ **都不是：部署在 /dev/ 的那份产物根本没有这个入口**；顺带给 D13 收口
  - 做了什么：① 给 `ui/dev-entry.tsx` 的入口加 `data-testid='devroom-entry'`（出图/断言要能按 testid 抓到它，不认中文文案）；
    ② 用 `VITE_DEVROOM=1 pnpm exec vite build --outDir .tmp-d15-probe` 造一份**真的 dev 制品**，用 CDP 探针量它；
    ③ 直接抓**线上跑着的那份** `http://191.40.41.97/dev/` 的 chunk 找入口；
    ④ D13：`diagnostics.tsx` 加 `isDebugOff()` + debug 关闭分支（只留一句说明），`routes/admin/diagnostics.tsx` 改喂 `code`，
    `bits.tsx` 的 Panel/StatRow 透传 `data-testid`，出图桩加 `?debug=0`。
  - 证据：
    ① **会不会被摇掉**：`.tmp-d15-probe/assets/index-Un4L35Ze.js` 里 `devroom-entry`/`开发页面`/`devroom` 三个串**都在**
    （同一份源码不带变量构建时三个串 0 命中）→ **不是被摇掉**；
    ② **可不可见/可不可点**（CDP，dev 制品，`/tmp-d15-probe` 静态服务）：1440 → `hasEntry:true, rect:[1280,844,144,40],
    position:fixed, z:50, insideViewport:true, hitTest:true, href:"/devroom/"`；390 → `rect:[258,732,120,32], hitTest:true,
    overlapsFooter:false`；点它 → `url:"/devroom/"`（真跳进去了）。控制台 0 问题。
    ③ **线上那份是坏的（根因）**：`curl http://191.40.41.97/dev/assets/index-HnB4KyJ6.js`（385030 B）里
    `devroom-entry`/`开发页面`/`开发者房间`/`devroom` **四个串全部 0 命中** → 跑在 /dev/ 上的这份是**不带 VITE_DEVROOM 的生产构建**，
    所以首页上没有按钮：不是没渲染、不是被盖住，是**根本没打进产物**。
    ④ D13 **先红后绿**：`npx vitest run src/devroom/pages/15-admin/screens/diagnostics.test.tsx` →
    改前 `Tests 3 failed | 1 passed`（`isDebugOff is not a function` / 空指标格与 alert 卡都在），改后 `4 passed`。
    图：`shots/fixadmin/d13-diag-debug-off.png`（只留一句说明，**没有** 404 卡与「—」格）、`d13-diag-default.png`（debug 打开照常）、
    `d13-diag-debug-off-390.png`（窄屏同样只有一句）。
  - 下一步：第 2 步做 D12（`screens/ai-review.tsx` 的连通测试：先写会红的断言 → 加失败态 prop → DevRoom 出图 → 宿主 `routes/admin/ai.tsx` 跟着改），
    然后 D14（`screens/shell.tsx` 的 AdminShell 改吃真 session）、最后 D15 把「dev 制品必须带入口」做成 `check-bundle.ts` 的门禁。
  - 阻塞：无（`web/src/main.tsx` 与 `app/shell.tsx` 是 Lead 专属，本包没碰）

- [x] 第 2 步：D12 连通测试失败**就地**显示 + D14 管理员卡喂真 session（两个入口同一份 View）
  - 做了什么：**① D12**：`screens/ai-bits.tsx` 新增 `AI 测试失败回执`（`AiTestFailure` + `TestFail`，`data-testid=ai-test-fail`、`role=alert`），
    `screens/ai-review.tsx` 新增 `testFailure` prop 并优先渲染它；`routes/admin/ai.tsx` 新增 `classifyTestFailure()`（401/403→auth、
    408/网络层(status 0)→timeout、5xx→server）＋ `onError` 改 `setTestFailure`（原来写的是 `setReceipt`，而回执区在屏幕**最上方**、
    按钮在下面的「连通测试」面板里 → 点了像没反应）；**没配 key 时用配置里的 has_secret 在点之前判掉、不发那次必然失败的请求**。
    **② D14**：`screens/shell.tsx` 的 `AdminShell` 改成吃 `me: AdminSelf | null`，去掉写死的「示范管理员 @demo-admin / 管理员」，
    拿不到 session 时**不画人**、只留一句 `admin-self-missing`；`routes/admin.tsx` 喂真 session；DevRoom 页喂演示者（`?me=0` 演没有那一态）。
    `preview/admin-fixtures.ts` 加 `?aitest=nokey|401|timeout|500` 与 `?debug=0`（出图用）。
  - 证据：`npx vitest run src/routes/admin/ai.test.tsx`：**改前 5 failed**（`ai-test-fail` 查不到、成功态也查不到回执）→ **改后 4 passed**；
    `npx vitest run src/devroom/pages/15-admin/shell.test.tsx` **3 passed**；合跑 `2 files / 7 passed`。
    **会红验证**（不只说「已通过」）：把宿主里「没配 key 就不发请求」那段临时改成 `if (false && …)` →
    `✗ AssertionError: expected '服务端内部错误后端在执行这次外呼时挂了：服务端内部错误（HTTP 500）…' to contain 'API Key'`
    —— 证明这条断言真的钉住了「缺 key 不能说成服务端内部错误」；改回去即绿。
    图（1440 与 390）：`shots/fixadmin/d12-ai-nokey.png`（「还没配密钥」+ 去配 key 的指引）、`d12-ai-ok.png`（连通成功 + verdict/延迟/原始输出）、
    `d12-ai-401.png`、`d12-ai-timeout.png`（「按拿不准转人工，**不是放行**」）、`d12-ai-500.png`（带 req-shot 编号）、`d12-ai-nokey-390.png`；
    `d14-devroom-session.png` 与 `d14-product-session.png`（**同一份 AdminShell**：管理后台 / 用户管理 + 右上角卡一模一样）、
    `d14-devroom-no-session.png` 与 `d14-devroom-no-session-390.png`（没 session：不画人，只留一句为什么空着）。
  - 下一步：第 3 步做 D15 —— ① `web/scripts/check-bundle.ts` 第 4) 段加一条「`dist/devroom/` 在 ⇒ 产品侧必须有 DevRoom 入口」
    （这正是线上 /dev/ 那份坏制品的形状），先证明它会红再证明它绿；② 复跑出图确认 1440/390 都 insideViewport+hitTest。
  - 阻塞：**`pnpm typecheck` 与 `pnpm lint` 现在整体是红的，但与我无关**：`web/scripts/cdp-shot.ts`（FIX-MSG 在 1938cd6 提交的）
    typecheck 22 条错、eslint 2 条错；`web/src/routes/issues.new-issue.test.tsx`（FIX-TOPIC 在途）eslint 1 条错（手写 `<input>`）。
    我的文件：`pnpm typecheck` 过滤掉 cdp-shot.ts 后 **0 条**；`pnpm lint` 的 27 条里 0 条出自我改的文件。**请 Lead 让那两位收口。**

- [x] 第 3 步：D15 把「dev 制品必须有入口」做成门禁（先红后绿）+ 入口可见可点的最终出图
  - 做了什么：`web/scripts/check-bundle.ts` 第 4) 段新增 **4b-③**：**`dist/devroom/` 在（= 这是 dev 制品）而产品侧一个 DevRoom 入口都没有 → 红**，
    并给出修法（按 pack-dev.ts 重新构建）。判据刻意**不是**「产品侧必须有入口」——那样真正的生产构建（只有 dist/index.html）会当场红。
  - 证据：**会红**：把真 dev 制品拷成 dist、只把产品侧那份 JS 换成**不带 VITE_DEVROOM 的构建**（就是线上 /dev/ 的形状）→
    `node scripts/check-bundle.ts` **exit 1**，输出里那条是
    `✗ 这是 dev 制品（dist/devroom/ 在），但产品侧一个 DevRoom 入口都没有 —— 这次产品构建多半没开 VITE_DEVROOM=1（pack-dev.ts 是用 VITE_DEVROOM=1 构建的）。后果是 DevRoom 服务着却进不去（D15）。`；
    **会绿**：按 pack-dev.ts 的配方重建（`VITE_DEVROOM=1 pnpm exec vite build` + preview-dist 并入 dist/devroom + devroom.html→index.html）→
    `产物自洽检查通过：入口齐、20 个 DevRoom 页面在产物里、30 个资源都在、dev 制品：产品侧 DevRoom 入口 3 处，dist/devroom/** 自己的 15 处`，**exit 0**。
    **最终出图**（服务的就是上面那份完整 dev 制品）：1440 → `hasEntry:true, href:"/devroom/", rect:[1280,844,144,40], position:fixed, z:50,
    insideViewport:true, hitTest:true`；390 → `rect:[258,732,120,32], insideViewport:true, hitTest:true, overlapsFooter:false`；
    **点它** → `url:"/devroom/", title:"DevRoom · 控件验证", rootChildren:1`（真跳进房间了）。控制台 0 问题。
    图：`shots/fixadmin/d15-final-1440.png` / `d15-final-390.png`（右下角「开发页面（临时）」胶囊，不压页脚）/ `d15-final-click.png`（点进去之后的 DevRoom 首页）。
    生产零痕迹那条（4b-②）**继续管着**，我只加强了它：不带 `VITE_DEVROOM` 的构建仍 0 命中（那一档 dist/devroom/ 也不在，所以 4b-③ 不进分支）。
  - 下一步：收尾 —— 跑 `pnpm typecheck && pnpm lint && npx vitest run` 全量，把三条阻塞写给 Lead，按 PID 关掉自己起的进程。
  - 阻塞：同第 2 步（`scripts/cdp-shot.ts` 的 typecheck 22 条 + eslint 2 条、`issues.new-issue.test.tsx` 的 eslint 1 条，都不是我的文件）。
    另：`pnpm build` 现在会**先跑 tsc**，所以 **`pack-dev.ts` 与 `deploy.ps1` 现在都跑不动**（第 1 条阻塞的连带后果）—— 请 Lead 先让 cdp-shot.ts 收口。

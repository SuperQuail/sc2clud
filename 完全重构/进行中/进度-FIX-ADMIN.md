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

# 进度 · FIX-COVER（D21 + D27：分区封面在帖子页左栏与后台分区管理两处不显示）

> **作用域**（派发包）：`web/src/routes/topic.tsx`、`web/src/devroom/pages/03-navigation/**`、
> `web/src/devroom/pages/12-topic/**`、`web/src/devroom/pages/15-admin/screens/boards.tsx`、
> `web/src/routes/_parts/layout.tsx`、`web/src/lib/**`（只加纯函数）、本文件。
> 实际多碰了两个「我的改动会打到」的文件（都是调用方/修点，逐条在下面说明）：`web/src/routes/_parts/topic-mappers.ts`（D21 的修点本身）、
> `web/src/routes/_parts/mappers.ts`、`web/src/devroom/pages/18-compose/index.tsx`（`12-topic/mock` 的调用方）。
> **不许改**：`web/src/app/router.tsx`、`web/src/app/shell.tsx`、`web/src/main.tsx`（Lead 专属）、`deploy/**`。
> **后端**：不动（服务端**已有**封面数据；D21/D27 两条都是前端）。**没有迁移**（所以没有 0052 这个号可报）。
> **基线**：本轮开工 HEAD = f121c63，前端 53 文件 / 262 用例全绿。
> **协议**：每小步一个提交、只 add 自己改的文件、同一提交更新本文件（四行：做了什么/证据/下一步/阻塞）。
> **方法（清单 §0）**：页面 = prop 驱动的 View（`devroom/pages/<页>`，只吃 props、不 fetch、不认路由）
> + 极薄宿主（`routes/`，只取数与传参）。顺序固定：① 改 View → ② DevRoom 出图 → ③ 宿主跟着改 → ④ 产品页出图。

## 先核（清单 §0 要求的「先证明断言会红」之前那一步）

派单里对 D21 的初判是「`routes/topic.tsx` 给左栏传 `BOARD_NAV` 常量表（无封面字段）」——**核过，不成立**：

| 项 | 实测 |
|---|---|
| `BOARD_NAV`（`routes/topic.tsx:49-54`） | 是**分区内导航**（全部/讨论/资源/转载 的 kind 筛选），不是分区列表；它本来就没有封面字段，也不需要 |
| 左栏的分区列表 | `boards={allBoards}` —— **已经是真数据**（`GET /boards`，`routes/topic.tsx:80-84, 244`） |
| 真正的修点 | ① `_parts/topic-mappers.ts:137` 的 `toDesignBoard` 读 `b.cover` —— 而 `BoardDTO`（`forum/internal/forum/dto.go:43`）里叫 **cover_hash**、没有 `cover` 这一列 → 恒为 `''`；② `12-topic/left-rail.tsx` 是**第二份分区列表实现**（自己画行、自己拼 `<img src={b.cover}>`，不带 `imagePath`/占位），与补过封面位的 `03-navigation/board-rail.tsx` 是两套 |

**所以结论与派单一致、理由不同**：不是「两套数据源」，是「一份映射读错字段 + 两套封面实现」。修法照派单：让帖子页左栏**走 03-navigation 那份 View**，
于是第二份分区列表整块消失，封面逻辑只剩一份。

## 记录

- [x] **D21（帖子页左栏不显示分区封面）：左栏的分区列表改走 `03-navigation/board-rail` 的 BoardRail，删掉第二份实现**
  - 改法（6 处，全是「让两处变成一处」）：
    ① `12-topic/left-rail.tsx`：删掉自己那份分区行（含自己拼的 `<img>`），分区列表改渲染 `<BoardRail boards current link>`；
       它的 props 从 `Board[]` + `boardHref` 变成 `BoardSummary[]` + `link`（落地件由宿主给，View 里仍无 react-router）。
    ② `12-topic/types.ts`：`Board.cover`（设计稿的路径）→ `Board.cover_hash`（**后端 DTO 的真名字**，裸哈希）。
       `Board` 因此成了 `BoardSummary` 的超集，房间的 `BOARDS` 不用再拆两份。
    ③ `_parts/mappers.ts`：新增**唯一一份** `boardRows(BoardDTO[]) → BoardSummary[]`（首页/分区页宿主与帖子页宿主都调它）。
    ④ `_parts/layout.tsx`：`BoardRail` 宿主改用 ③，并把 `RailRouterLink` 导出给帖子页宿主。
    ⑤ `_parts/topic-mappers.ts`：`toDesignBoard` 读 `cover_hash`（`raw.cover_hash ?? raw.cover ?? ''`，兼容 lib 里那份还没收口的 `cover`）。
    ⑥ `board-summary.tsx`（右栏分区简介）、`18-compose/index.tsx`（`12-topic/mock` 的调用方，字段改名打到它）：
       封面一律走**同一份** `BoardCover`（占位、`imagePath` 前缀都在它那里）。
  - 宿主（`routes/topic.tsx`，只改传参）：`boards={boardRows(boards.data ?? [])}` + `boardLink={RailRouterLink}`。
  - **断言先红**（`12-topic/topic-view.test.tsx` 新增「D21：左栏分区列表画封面（cover_hash → /img/<hash>），没有封面的那一行落首字占位」）：
    改之前 —— `AssertionError: expected undefined to be '/img/abc123'`（左栏那一行**根本没有 `<img>`**，正是用户报的现象）；
    `routes/topic.test.ts` 那条改名的（`b.cover_hash`）在旧实现下也是红的：`expected '' to be 'abc123'`（临时把 `toDesignBoard` 还原成旧行为跑出来的，跑完已恢复）。
  - 证据（出图，`web/scripts/cdp-shot.ts` + `preview:build` 到 `.tmp-fixcover-dist` + `serve-preview.ts 5296`，图在 `web/shots/fix-cover/`）：
    · `d21-room-topic-1440.png`（房间 12-topic，图上左下角有 `FIX-COVER D21 ROOM 12-topic` 标记）：左栏五个分区**都有封面图**，右栏分区简介也有；
    · `d21-product-topic-1440.png`（产品 `product.html?route=/t/tp-1`，标记 `MARKER-PRODUCT-LOGIN /t/tp-1`）：左栏 6 行里 5 行是真封面、
      「皇帝区」（`cover_hash: ''`）落**蓝色首字「皇」占位**，右栏分区简介同样有封面。
    · 出图数据：`preview-dist/img/<sha256>` 是**内容寻址**的静态替身（生产上 `/img/<hash>` 由后端 media 读口提供），
      拷的是 `web/public/art/starcraft/nav-*.webp`（**文件名就是它的 sha256**，与 `完全重构/迁移素材/board-covers.json` 同一份素材）。
  - 证据（门禁）：`npx vitest run` **53 文件 / 262 用例全绿**；`npx tsc --noEmit` 我的文件 0 错
    （工作区里另有在途红：`15-admin/mock/fixtures.ts` 缺 `body_md/body_truncated`，是 FIX-ADMIN 的 D25 在途）；
    `npx eslint` 我改的文件 **0 error**（`_parts/layout.tsx` 那份 react-refresh 警告我把 `boardRows` 挪进 `mappers.ts` 后消失）。
  - 并发记账 ①（索引被清）：本步的 12 个代码文件曾被并发的 `git reset`（D25① 在 `git reflog` 里留了
    `reset: moving to HEAD` / `HEAD~1` 两条）清出暂存区，第一次提交只带上了本文件 —— 已用 `git reset --soft` 重新合成一个提交。
    **教训**：这台机器上多人同时施工，`git add` 与 `git commit` 之间不要隔太久。
  - 并发记账 ②（不是我的提交，但内容是我的）：`web/src/devroom/pages/12-topic/topic-view.tsx` 那 19 行被 **502ed1b（D22 收款码弹层）**
    一起卷进了别人的提交（对方 add 的范围偏大）。`git diff 502ed1b -- topic-view.tsx` 为空 = 与我现在这份逐字相同，内容没丢；
    只是 review 时别以为「topic-view.tsx 的封面改动」属于 D22。
  - 下一步：D27（后台分区管理的裂图）。
  - 阻塞：无。

- [x] **D27（管理页「分区管理」稳定裂图）：两处封面用的是 `assetUrl`（public/art 的拼法），改回 `imagePath`**
  - 根因（与 D21 **分别取证**，两条不是同一个原因）：`assetUrl(file) = appPath('art/' + file)` 是 **public/art 静态素材**的拼法；
    而分区封面是**图片端点**的资源（生产由后端 media 读口给 `/img/<hash>`）。于是
    `assetUrl('/img/' + cover_hash)` 拼出来的是 **`/dev/art/img/<hash>`** —— 站上没有这条路径 → 稳定裂图。
    两处都在 `15-admin/screens/boards.tsx`：列表行缩略图（32×32，:172）与「分区资料」里的预览（96×56，:277）。
    **D21 是字段名读错（读不到哈希），D27 是 URL 拼错（拿到了哈希却拼错前缀）** —— 现象像，根因不同。
  - 改法：两行 `assetUrl` → `imagePath`（`@/lib/url` 的全站唯一 URL 入口）。`assetUrl` 的 import 随之删掉。
  - **删掉一张掩盖它的假映射**：`web/public/art/img/c0c0c0…`（018a952 出的图那次加进去的，注释里只提了
    `public/img/<hash>`）。它让**错的那个 URL 在出图里也能解析**，所以这条缺陷在截图里一直看不见；
    代码里没有任何地方引用 `art/img`（grep 0 命中），删掉它、缺陷才在出图里现形。
    （真实的五个分区封面在 dev 上是 `nav-*.webp` 的 sha256，`art/img/` 下**一个都没有** → 用户看到的就是五张裂图。）
  - **断言先红**（`15-admin/screens/boards.test.tsx` 新增「D27：封面图的地址是 imagePath 那条」）：
    改之前 —— `AssertionError: expected '/art/img/aaaa…' to be '/img/aaaa…'`。
  - 证据（出图，`.tmp-fixcover-dist` + `serve-preview.ts 5296` + `admin.html?route=/admin/boards&asAdmin=1`）：
    · `web/shots/fix-cover/d27-product-admin-boards-before-1440.png`：**临时**把两行还原成 `assetUrl`、重建后拍到的**裂图**
      （列表里「自制战役」那一格与右侧预览都是碎图标）—— 缺陷可复现；
    · `web/shots/fix-cover/d27-product-admin-boards-1440.png`：改回 `imagePath` 后同一屏，两处都出图（缩略图 + 96×56 预览），
      同屏还能看到另外三行（`cover_hash` 为空）的虚线占位 —— 两条分支一张图里都在；
      两张图左下角都有 `MARKER-ADMIN /admin/boards`（证明拍的是当前源码）。
    · URL 对照（对同一个 hash 直接取）：`/img/<hash>` → **200**（10822 字节）、`/art/img/<hash>` → **404**。
  - 证据（门禁）：`npx vitest run` **55 文件 / 275 用例全绿**；`npx tsc --noEmit` **0 错**；`npx eslint` 两个文件 0 问题；
    `gate:size` 通过（`boards.tsx` 510 行，与改前**一行不差** —— 登记里写着「行数只减不增」，所以我没往里加注释，
    理由写在这里与测试名里）；`gate:urls` / `gate:ui` / `gate:tokens` / `gate:controls` 全通过。
  - 下一步：无（D21 / D27 两条都收工）。给 Lead 的验收建议：真站上重开一次 `/dev/admin/boards`（硬刷新，旧 bundle 有缓存）
    看五张分区封面；帖子页 `/dev/t/<id>` 左栏看同一批封面。
  - 阻塞：无。

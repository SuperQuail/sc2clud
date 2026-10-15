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

# 进度 · FIX-TITLE（D16 / D17 / D18 / D19）

> 作用域：`web/src/devroom/pages/12-topic/author-card.tsx`、`web/src/devroom/pages/11-profile/**`、
> `web/src/ui/user/**`、`web/src/routes/profile.tsx`、`web/src/lib/api/{user,title}.ts`、
> `web/src/lib/query/keys.ts`（只加 key）、本文件。
> **后端一行没改**：三条端点（`PUT /me/title`、`GET /users/{handle}/titles`、`PUT/DELETE /users/{handle}/follow`）
> 都已经在 `forum/internal/{title,follow}/handler.go` 里，字段名照它们的 DTO 抄（见下）。
> 出图端口 5217（vite dev，只用我自己的号），收工释放；`cdp-shot.ts` 加了三个动作（size/scroll/mark）。

- [x] D16 + D17：作者卡不再编「无头衔」，头衔那一行与头像/昵称/角色同一条中轴
  - 证据：`npx vitest run src/devroom/pages/12-topic/author-card.test.tsx` —— **先红**：
    `Tests 2 failed | 1 passed`，两条失败正是缺陷本身
    （`AssertionError: expected '示示范管理员@demo-admin管理员战役作者…无头…' not to contain '无头衔'`、
    `Unable to find an element by: [data-testid="author-title-row"]`）；改完 `Tests 3 passed (3)`。
    · 图（都看过）：`shots/fix-title/d17-author-card-1440.png`（DevRoom 12-topic，1440x1250）、
    `shots/fix-title/d17-author-card-390.png`（390x1000，滚到作者卡）、
    `shots/fix-title/d16-no-title-product-1440.png`（**产品页** /t/tp-1 + `MARKER-PRODUCT-LOGIN`：
    头衔为 null 时那一行只剩「邮箱已验证」，没有「无头衔」这一枚）。
    · 工具：`cdp-shot.ts` 加 `size:WxH` / `scroll:<css>` / `mark:<文本>` 三个动作（窄屏图与 §5.4 的自证标记）；
    这三个动作已被 Lead 的 `2ee918a` 一并提交（我这边 `git diff` 因此为空，不是没改）。
  - 下一步：D18 主页头衔下拉（`profile-hero.tsx` 的 TitleBadge + `routes/profile.tsx` 传参）。
  - 阻塞：无

- [x] D18：本人主页的头衔可点开下拉（佩戴 / 不佩戴），别人只显示；选完调 `PUT /me/title` 并刷新
  - 证据：`npx vitest run src/routes/profile.test.tsx`（新文件，4 条）—— **先红**：
    `Tests 3 failed | 1 passed`，两条是 `Unable to find an element by: [data-testid="dropdown-trigger"]`、
    一条是测试自己查重（页面本来就把头衔画两处）；改完 `Tests 4 passed (4)`，含
    「选中 → `PUT /api/v1/me/title` 且请求体 `{title_id:'ti-2'}`」与「不佩戴 → `{title_id:''}`」两条。
    · 契约字段名照 `forum/internal/title/{handler,types}.go`：`GET /users/{handle}/titles` →
    `{items:[{id,key,name,color,description,archived_at}], equipped_id}`（"" = 未佩戴）、
    `PUT /me/title {title_id}` → 204（`""` 或 null = 卸下，`Equip` 判的是 "" 那一条）。
    · 图（都看过）：`shots/fix-title/d18-title-closed-1440.png`（**常态与普通徽标完全一样**：
    没有箭头/下划线/底色）、`d18-title-menu-1440.png`（点开：执政官[当前] / 首席设计师 / 不佩戴）、
    `d18-title-menu-390.png`（390 窄屏，浮层不越界）。
    · 落点在 **hero 的身份行**（昵称与角色徽标那一行）—— 那一处才是「主页头衔」；右栏「徽章」格里那枚
    保持纯展示（同一页同一个动作不做两个入口）。
  - 下一步：D19 用户关注（作者卡 + 个人主页，`PUT/DELETE /users/{handle}/follow`）。
  - 阻塞：无

- [x] D19：关注**用户**（后端 `PUT/DELETE /users/{handle}/follow` 与 `GET .../follow` 一直在，前端此前零调用）
  - 证据：先红 —— `npx vitest run src/routes/profile.test.tsx src/devroom/pages/12-topic/author-card.test.tsx`
    `Tests 7 failed | 8 passed`（7 条全是 `Unable to find role="button"/"link" …`：两处都还没有那颗按钮）；
    改完 **15 passed**（两文件），其中：点「关注」→ `PUT /api/v1/users/demo-voidray/follow` 且按钮按**回执**变「已关注」、
    再点 → `DELETE .../follow` 且回执 false 就变回「关注」、**自己看自己**没有任何带「关注」字样的按钮、
    未登录是「登录后关注」的链接（href 含 login）。全量 `npx vitest run` = `Test Files 51 passed / Tests 252 passed`。
    · 契约照 `forum/internal/follow/{handler,types}.go`：`State{target,slug?,handle?,following,follower_count}`，
    三条端点（GET/PUT/DELETE）回**同一份** State；关注与取关都幂等。
    · 落点四处：`author-card.tsx`（`follow?: AuthorFollow` 三态 props）→ `topic-view.tsx` 透传 `authorFollow`；
    `routes/profile.tsx`（GET follow 查询 + PUT/DELETE mutation，`onSuccess` 把**回执写回缓存**，不本地翻转）；
    两个房间页各接成本地状态。
    · 图（都看过）：`shots/fix-title/d19-author-follow-1440.png`（作者卡「关注」）、`d19-author-followed-1440.png`（→「已关注」）、
    `d19-author-follow-loggedout-1440.png`（→「登录后关注」）、`d19-profile-follow-1440.png` / `d19-profile-followed-1440.png`（房间主页）、
    `d19-profile-follow-product-1440.png` / `d19-profile-followed-product-1440.png` / `d19-profile-follow-guest-product-1440.png`
    （**产品页** /u/demo-admin，含 MARKER-PRODUCT-*）。
    · 顺手订正一处**假话注释**：`routes/profile.tsx` 原来写「关注没有端点（PUT /users/{handle}/block 是拉黑），所以不画」
    —— L5 之后端点在、缺的只是调用方。
  - 下一步：**唯一没接上的一处**是 `routes/topic.tsx` 的作者卡（那个文件是 FIX-JSON 的作用域，我按纪律没碰）：
    加一条 `fetchUserFollow` 查询 + `followUser/unfollowUser` mutation，把 `authorFollow` 传给 `TopicView` 即可
    （样板逐字照 `routes/profile.tsx`）；已把这段发给 Lead。
  - 阻塞：无（上面那处是交接，不是阻塞：View 侧三态与出图都已就绪）

## 收工验证（FIX-TITLE）

- `pnpm typecheck` = 0 错；`pnpm lint` = 0 error（17 warnings，全是仓库既有的 react-refresh / exhaustive-deps）。
- `npx vitest run` = **51 文件 / 252 用例全绿**（含本包新增的 11 条：D16/D17/D19 的作者卡 7 条 + D18/D19 的真站 profile 8 条 —— 其中 3 条是 D18 的）。
- 分门禁（`pnpm check` 不跑：它会 `pnpm build` 清 dist、同一时刻只允许一个人）：
  `gate:ui` / `gate:controls`（48 个已登记控件，没新增）/ `gate:urls` 全过；
  `gate:tokens` 我从 5 → 0 处（`src/preview/product-fixture.ts` 的头衔色改令牌），**剩下的 5 处都在
  `src/preview/admin-fixtures.ts`（`git show HEAD:…` 里就有，非本包引入）**；
  `gate:size` 红在 `web/src/routes/topic.test.tsx`（546 行，FIX-JSON 正在加断言的文件）——**不是本包文件**，
  本包改过的 8 个文件里最长的是 `routes/profile.tsx`（约 430 行）。
- 出图端口 5217（vite dev）为本包自取，收工按 PID 关；`shots/fix-title/` 是本包的图（`shots/` 在 .gitignore 里，与前任们一致）。

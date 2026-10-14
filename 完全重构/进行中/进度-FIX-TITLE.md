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

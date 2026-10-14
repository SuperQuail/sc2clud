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

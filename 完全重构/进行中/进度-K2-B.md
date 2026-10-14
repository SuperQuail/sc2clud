# 进度 · K2-B（封面 / 壁纸替换，拍板 08 第二轮）

> 作用域：`forum/internal/forum/admin_boards_write.go`、`forum/internal/forum/**`（只碰封面/背景相关）、
> `web/src/devroom/pages/15-admin/screens/boards.tsx`、`web/src/routes/admin/**`、`web/src/routes/profile.tsx`、
> `web/src/routes/settings.tsx`、`web/src/lib/api/{admin,user}.ts`。
> 迁移号：Lead 点名 **0030**（0029 被 L6 的 `topic_revisions_pending` 先占）。
> 出图台：`web/scripts/shoot-k2b.ts`（CDP 直连 headless Chrome，端口 9443；dev server 用 5261）。

## 进度

- [x] 修「清空封面」不生效（`admin_boards_write.go:132-135`）+ 迁移 0030 `users.cover_hash`
  - 证据：`go test ./internal/forum/ -count=1` → `ok forum/internal/forum 75.1s`（含新增
    `TestUpdateBoardCoverHashDistinguishesAbsentFromClear`：换一张 / 只发空串能清空且库里真是 NULL /
    只改别的字段时封面原样保留 / 两条审计的 after 各记各的）。
    旧行为下 ② 会红在「400 没有要改的字段」、③ 会红在「封面被顺手清掉」。
  - 下一步：（已做）见下一条。
  - 阻塞：无。

- [x] 后台分区屏：封面的替换与清空都能点、都有效果
  - 证据：`pnpm typecheck`（我的文件 0 错）+ `npx vitest run` 36 文件 184 用例全绿；
    新用例 `web/src/devroom/pages/15-admin/screens/boards.test.tsx` 先证会红：
    摘掉 patch 里那一行 `cover_hash` → `Unable to find role=button and name "保存 1 项改动"`。
    出图 `shots/k2b/admin-board-cover-before-1440.png`（有封面：预览 + 更换封面 + 清空封面）
    与 `admin-board-cover-cleared-1440.png`（点清空后：预览回占位块、右上「未保存 / 保存 1 项改动」）。
  - 下一步：无（两条路都通）。
  - 阻塞：无。

- [x] 个人主页的背景/封面替换：从「点了没反应」变成真能用
  - 结论：**入口在，动作是假的**。`盲审-二号-核心链路.md` 记的那颗「更换封面」从没接后端
    （`ProfileHero` 的 `onCoverPick` 不存在、DevRoom 那颗是 disabled 占位），根因是 users 没有封面列、
    media 也没有封面通道 —— 这就是用户说的「设置背景功能消失」。
  - 做了什么：0030 `users.cover_hash` + media 域 `POST/DELETE /me/cover`（与头像逐字同构）+ 
    `user.Profile.cover`（`GET /users/{handle}`）+ 共用弹层 `@/ui/cover-picker`（原生 dialog）+
    `image-uploader` 的 cover 形态（16:9）+ `/settings` 一格 + hero 右上那颗真按钮
    （看别人主页时是**明确禁用 + title 说原因**，不是消失）。
  - 证据：`go test ./internal/user/ ./internal/media/ -count=1` → 两个包 `ok`（新增
    `TestUploadAndClearCover`：没设过时 clear 幂等 / 同内容重传不新建 / 换一张新旧 refcount 对 /
    清空置 NULL 且归零）。出图 `shots/k2b/profile-cover-applied-1440.png`（hero 上是真封面）、
    `profile-cover-dialog-1440.png`（更换封面弹层）、`settings-cover-1440.png`（设置页同一格）。
  - 下一步：无。
  - 阻塞：无。

## 过程（给接手的人）

1. **出图台的坑**：`shoot-k2b.ts` 原先写 `/admin.html?...`，而 base 是 `…/product.html` → 拼成
   `product.html/admin.html` → 图上是一张**漂亮的 404**（与「拍到了旧产物」长得一模一样）。
   后台那一屏必须写**绝对 URL**。另外必须先开 `about:blank` 再 `Page.navigate`，否则页面加载期的
   `console.error`（「Query data cannot be undefined」）收不到，读图读不出根因。
2. **`/img/<hash>` 在预览里不存在**：产品页的 `assetUrl` 前缀是 `/art`，所以桩数据里的封面 hash
   要放在 `web/public/art/img/<hash>`（已放一张 96×54 渐变占位图），否则图上只有裂图。
3. 与另一个 agent 撞过三次：`forum/internal/forum/{dto,map,topics,issues,handler}.go`、
   `web/src/routes/topic.tsx`、`web/src/devroom/pages/15-admin/screens/review.tsx` 都是**别人的在途文件**，
   本轮一个字节都没碰（`pnpm typecheck`/`pnpm lint` 现存的那几条 error 全在它们里面）。

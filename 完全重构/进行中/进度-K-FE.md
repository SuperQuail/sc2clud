# 进度 · K-FE（前端 + 打赏整块 + 私信图片）

> 作用域：`web/src/routes/**`、`web/src/devroom/pages/**`、`web/src/lib/api/**`、
> `web/src/ui/message/notice-chat.tsx`（点名授权）、`完全重构/UI与后端对齐.md`、本文件。
> **不碰**：`web/src/app/**`、`web/vite*.config.ts`、`web/package.json`、`forum/**`。
> 依据：`08-拍板记录.md`（用户拍板）+ `07-一次性完工交接单.md`（环境/协议/陷阱）。
> 基线：`pnpm typecheck && pnpm lint && npx vitest run` 绿（28 文件 / 146 用例）；`go test ./...` 34 包绿。

## 队列（照 08 的顺序，一条一提交）

- [ ] L1 打赏/赞助整块前端接线（收款码上传/删除、打赏、我的打赏记录、收款码可见性、SponsorCard/RewardPanel 接真数据）
- [ ] L2 首页/分区页「最热」排序（**阻塞**：等 K-BE 交 `sort=hot` 与字段名）
- [ ] L6 作者侧「打回修改」横幅 + 「查看最后过审版本」入口（**阻塞**：等 K-BE 加第四态 + 最后过审版本字段）
- [ ] J3 只显示点赞数；点踩数据按身份渲染（**阻塞**：等 K-BE 决定踩的下发口径）
- [ ] J5 Issue 检索/筛选界面补全（**阻塞**：等 K-BE 的三个新字段）
- [ ] J9 卡片用上 `cover_width`/`cover_height`（**阻塞**：等 K-BE 加字段）
- [ ] L8 私信图片（**阻塞**：media 没有通用图片上传端点，见阻塞一节）+ Unicode 表情不被正文链路破坏
- [ ] L7 「已提交复审」反馈真页面验证 + G5 消息屏蔽词 WIP 标记
- [ ] L3 / L4 / L9 只写文档（AI 两套提示词 + temperature、Issue 标签表、搜索高亮/历史/热门词）
- [ ] `UI与后端对齐.md` 定位改错（「暂时隐藏」在打赏这块是文档定位错误）

## 阻塞（跨人依赖，先写清不造 mock 兜底）

- **L2**：需要 K-BE 的 `sort=hot` + 新游标键；字段名要照它交的变更表。
- **L6**：需要 `ck_topics_review_state` 加第四态（独立分类）与「最后过审版本」的存储/DTO 字段。
- **J3**：需要 K-BE 决定踩数（`dislike_count`）对谁下发；**接口不下发就不显示**，不在前端藏。
- **J5 / J9**：需要 K-BE 的 Issue 检索字段与 `cover_width`/`cover_height`。
- **L8**：`forum/internal/media/handler.go` 只有三条上传端点（`/me/avatar`、`/me/payment-channels`、
  `POST /topics/{id}/images`，后者绑在 topic 上）—— **没有通用图片上传端点**，私信发图无通道可复用。
  且 `message.MessageDTO.body` 是 `varchar(2000)` 纯文本（`message/service.go:133` `TrimSpace` + 2000 rune 上限），
  附加图需要正文形状变更或附件表。等 K-BE 交「图片通道 + 正文形状」后再接。

## 记录

- [x] **L1 第 1 步：把打赏域的前端客户端从零建起来**（新增 `web/src/lib/api/rewards.ts` + `rewards.test.ts`）。
  八条端点一次接齐：`GET /users/{handle}/channels`、`POST/GET/DELETE /me/payment-channels`、
  `POST /rewards`、`GET /me/rewards`、`GET /users/{handle}/rewards`、`GET/PATCH /me/donation-settings`、
  `DELETE /rewards/{id}`（撤回）。类型直接复用 `admin-types.ts` 已有的 `Donation`/`UserBrief`（不复制第二份 DTO）。
  - 证据：`cd web && npx vitest run src/lib/api/rewards.test.ts` → `Test Files 1 passed (1) / Tests 8 passed (8)`。
    **先证明会红**：把 `createDonation` 的路径临时写成 `'reward'` 再跑 → `1 failed | 7 passed`，
    `AssertionError: expected '/api/v1/reward' to be '/api/v1/rewards'`；改回 `'rewards'` 后 8/8 绿。
    全量：`npx vitest run` → `Test Files 30 passed (30) / Tests 158 passed (158)`；
    `pnpm lint` → `19 problems (0 errors, 19 warnings)`（都是既有的 react-refresh / exhaustive-deps 警告，非本次新增）。
  - 下一步：`web/src/routes/settings.tsx` 里加「赞赏与收款码」一节（新件
    `web/src/devroom/pages/11-profile/payment-channels.tsx`）：`useQuery(qk.donationSettings())` +
    `fetchMyDonations()` 列我的申报（撤回按钮走 `withdrawDonation`），收款码用
    `ImageUploader variant='avatar'` 选图 → `addPaymentChannel(file, label)`，列表项 `deletePaymentChannel(id)`；
    两个开关分别 PATCH `show_channels` / `records_public`；图一律过 `channelImageSrc()`。
    然后把 `web/src/routes/profile.tsx` 的 `SponsorCard` 与 `web/src/routes/topic.tsx` 的 `RewardPanel`
    接上真数据（两处现在分别写死 `channels={[]}` 与 `const channels = []`）。
  - 阻塞：**无**（本步只碰 `web/src/lib/api/**`）。
    另记一条**与本人无关的既有红灯**（交接单 §3.2「不许整文件覆盖」的受害面已经修好一半，
    但工作区里还有人没写完）：`pnpm typecheck` 现在报 2 个错，都在**别人作用域**的
    `web/src/devroom/pages/15-admin/index.tsx(34,18)` 与 `web/src/routes/admin.tsx(49,3)`
    （`TitlesScreenProps` 未供给，两文件都是 ` M` 在途状态，非我改动）。本条不会被我碰到；
    另：`--filter` 不可用的情况下我用了 `pnpm lint` 与 `npx vitest run`，两者均绿。

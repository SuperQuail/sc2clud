# 进度 · K2-A（J3 的最后一格 + L1 收款码可见性）

> **作用域**：`web/src/ui/comment/**`（第二轮拍板点名授权）、`web/src/routes/**`（只碰踩数显示相关的）、
> `forum/internal/media/**`、`完全重构/进行中/进度-K2-A.md`（本文件）。
> **基线**：前端 34 文件 / 175 用例、后端 34 包全绿；**不许弄红**。
> **协议**：每小步一个提交、只 add 自己改的文件、同一 commit 更新本文件（四行：做了什么 / 证据 / 下一步 / 阻塞）。
> **迁移号**：本轮**不需要迁移**（`images.visibility` 这一列早就在，只是写引用行时选错了档）。
> 另：0029 已被别的 agent 的在途迁移 `0029_topic_revisions_pending` 占掉（工作区未跟踪可见）。

## 记录

- [x] **J3 第 1 步：断言先红 —— 非特权用户那一格回答的是「我自己点没点」**
  - 做法：`web/src/routes/topic.test.tsx` 加 `mocks.posts`（回复列表可覆盖）+ 一条新用例：
    喂一条**没有 `dislike_count` 这个键**、`my_vote: -1` 的回复（= 后端对普通用户 / 游客的真实响应，
    `forum/internal/forum/dto.go:157` 的 `omitempty`），断言那颗按钮**读作「取消点踩」**（= 我踩过）、
    带 `ring-button-active`，且**里面一个数字都没有**。
  - 证据：`cd web && npx vitest run src/routes/topic.test.tsx` → `Tests 1 failed | 6 passed (7)`，
    失败点 `src/routes/topic.test.tsx:272`：`Unable to find role="button" and name "取消点踩"`
    （旧行为里那颗按钮恒读作「点踩」—— 「我自己点没点」在界面上没有任何可证伪的落点）。
  - 下一步：`ui/comment/types.ts` 的 `dislikes` 改可选 → `ui/comment/comment-actions.tsx` 只在
    `typeof dislikes === 'number'` 时渲染计数、可读名跟 `disliked` 走 → 两处映射去掉 `?? 0`。
  - 阻塞：无。

- [x] **J3 第 2 步：类型如实 + 只在 number 时渲染计数（含被类型变更带出来的两处调用点）**
  - 做了什么：
    · `ui/comment/types.ts`：`dislikes?: number`（注释写清 undefined = 后端按身份没下发，**不是 0 个踩**）；
    · `ui/comment/comment-actions.tsx`：prop 改可选，计数外面套 `typeof dislikes === 'number'`，
      可读名 `disliked ? '取消点踩' : '点踩'`（与点赞那颗 `取消点赞/点赞` 同一写法）；
    · `routes/_parts/mappers.ts` 的 `toComments` 与 `routes/issues.tsx` 的 `toComment`：删掉 `?? 0`
      （`?? 0` 等于前端替后端把信任边界补回来），并清掉那两段过期的「等授权」注释；
    · **被类型变更带出来的两处（不在我作用域，但类型一改就红，必须跟着改）**：
      `devroom/pages/08-comments/index.tsx` 与 `devroom/pages/12-topic/index.tsx` 的本地演示赞踩里
      `target.dislikes - 1` → `(target.dislikes ?? 0)`（两处各 2 行，纯类型适配，无行为变化）。
  - 证据：`cd web && pnpm typecheck` → 0 错（exit 0）；`pnpm lint` → `20 problems (0 errors, 20 warnings)`
    （逐条核过：无一条落在我改的文件上，都是既有的 react-refresh / exhaustive-deps）；
    `npx vitest run` → `Test Files 34 passed (34) / Tests 176 passed (176)`（基线 175 + 本条 1）。
    `npx vitest run src/routes/topic.test.tsx src/routes/issues.test.tsx` → 15/15（issues 那两条 J3 用例仍绿：
    「不下发时踩那一格没有数字」与「my_vote=1 → 点赞按钮 active」）。
  - 下一步（L1）：`forum/internal/media/service.go:260` 的 `AddPaymentChannel` 写引用行时不再固定
    `VisibilityPrivate`；先在 `media_test.go` 加「游客能取到收款码图」的红用例。
  - 阻塞：无（`forum/internal/media/**` 有别的 agent 的在途改动，见下面第 3 条记录）。
- [x] **L1：收款码的图不再固定 private —— 陌生人（登录的无关用户）与游客都真能取到**
  - 断言先红：**新文件** `forum/internal/media/channel_visibility_test.go`
    （没有写进 `media_test.go`：那个文件正被另一个 agent 在途修改，见下面「协作」一节）。
    一条用例量四种身份取同一张收款码：无关登录用户 / 游客 / 所有者 / 超管，都必须**不是占位图**。
    证据：`cd forum && go test ./internal/media/ -count=1` →
    `--- FAIL: TestPaymentChannelImageIsFetchableByStrangers`，
    `channel_visibility_test.go:52: 无关登录用户 必须真拿到收款码图（打赏面板要能扫），实际 &{Mime:image/png Size:69 Path: Placeholder:[137 80 78 71 ...] Body:<nil> Cache:false}`
    （旧口径只放行所有者 / 超管 / 持 `reward.verify`）。
  - 改法：`media/service.go` 的 `AddPaymentChannel` 写引用行时 `VisibilityPrivate` → `VisibilityPublic`，
    并把三处「可见性固定 private」的注释一并订正（`service.go` 的 `AddPaymentChannel` / `ListPaymentChannels`、
    `channel.go` 文件头、`dto.go` 的 `PaymentChannel`）。
  - **为什么不按 `show_channels` 选 `VisibilityLogin`/`VisibilityPublic`**：先上传码、之后再打开展示开关
    是常规顺序（前端设置页两块是分开的），档位若在**上传那一刻**定死，那一步之后游客拿到的仍然是占位图 ——
    正是本轮要修的现象。收款码本就是给人扫的公开图（老站 `AGENTS.md §9` 同一结论）；
    **要不要对外展示这个码**由作者侧 `show_channels` 开关管（reward 域列表闸：关着就回空数组），
    这才是「按渠道展示开关」真正管得住的那一半。代价：知道 hash 的人都能取图（hash 不可猜，
    且它本来就要给打赏者看），已在代码里留了 `shortcut:` 一行（将来要更细的控制再加一列）。
  - **09 收尾对照表 §8.4 说的「`media_test.go:246` 那两格」**：那张图是 **private 档**（帖子草稿图：
    未过审主题的配图，hash 只在作者手上），量的是「草稿图不许给陌生人」——新口径只把**收款码**那一档
    改成 public，private 档不放宽，所以那两格**保持 false 才是对的**（把它们改成 true 等于让所有草稿配图
    对陌生人开放）。收款码那一档由新用例量，两条口径各自钉住。
  - 证据：`go fmt ./internal/media/`（无输出）· `go vet ./...` → exit 0 ·
    `go test ./internal/media/ -count=1` → `ok  forum/internal/media  21.983s`。
  - 下一步：无（J3 与 L1 都做完）。
  - 阻塞：无。

## 协作（同一工作区里还有别的 agent 在跑）

- 我做 L1 时，`forum/internal/media/**` **正被另一个 agent 在途修改**（个人主页封面 / 背景上传：
  `UploadCover`/`ClearCover`、`/me/cover`、`users.cover_hash`，还带着它自己的 `media_test.go` 新用例；
  迁移文件在工作区里还是未跟踪的）。所以：
  · 我的用例写成**新文件**，不去动它的 `media_test.go`；
  · 提交时对 `service.go` / `dto.go` 这两个**共享文件**用
    `git hash-object -w --path … ` + `git update-index --cacheinfo` 只把我的 hunk 放进索引，
    **它的在途改动留在工作区**（`git diff` 里仍看得到），不会被我的提交带走。
    验证：`git show --stat HEAD` 只有我的文件；`git status` 里它的在途文件仍是 modified。
- **迁移号 0029 已被占**（工作区未跟踪的 `0029_topic_revisions_pending.up/down.sql`，是 6.2 那一轮的工作），
  本轮 **L1 不需要任何迁移**（`images.visibility` 这一列早就在，只是写引用行时选错了档）。

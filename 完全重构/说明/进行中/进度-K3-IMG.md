# 进度 · K3-IMG（图文帖整块做完 + L1 按渠道可见性 + media 域可见性口径）

> **作用域**：`forum/internal/media/**`、`forum/internal/forum/images_*.go`（若需）、迁移 0031+、
> `web/src/ui/rich/**`、`web/src/routes/compose.tsx`、`web/src/lib/api/{forum,media}.ts`、
> `web/src/devroom/pages/18-compose/**`、`完全重构/后端设计/d5-content.md`、本文件。
> **基线**：前端 34 文件 / 176 用例；后端 34 包。**不许弄红**。
> **协议**：每小步一个提交、只 add 自己改的文件、同一 commit 更新本文件（四行）。
> **迁移号**：**0031 起**（0029 = K2-C 的 topic_revisions_pending，0030 = K2-B 的 users_cover_hash）。
> 截至本文件创建时，本轮**还没有用到迁移**（可见性那一列早就在）。

## 记录

- [x] **L1 第 1 步：收款码的档位改由「渠道展示开关」在读路径上调（K2-A 的 VisibilityPublic 方案作废）**
  - 先读了老站实现（拍板第三轮点名「去 site/crates/sc2clud-web/** 看老站怎么按渠道展示并照做」）：
    pages_profile.rs:93-94 上传收款码时 repo::set_blob_visibility(..., 1) = **登录可见那一档**；
    pages_settings.rs:253-275 的「展示开关」donation_visible 与 repo::list_payment_channels 一起决定
    这个人有没有打赏入口。**老站没有写死 public** —— K2-A 那一版（public + 列表闸）是偏离。
  - 改法（forum/internal/media/service.go + repo.go）：
    · AddPaymentChannel 的引用行 VisibilityPublic → VisibilityLogin（老站那一档），并写清它**不是**
      在上传那一刻定死的；
    · canView 加一支：登录可见的图，作者本人 / 超管照旧放行，其余人（**含游客**）看 channelDisplayed()
      —— channelImageWithDisplayOn() 一条 EXISTS：这张 hash 是**这个作者**的收款码，且
      user_donation_settings.show_channels 开着 → 放行；关着 → 占位图。
    · 档位因此**在上传之后仍可调整**（上传之后打开展示开关，同一张码立刻对登录用户与游客可见），
      而关掉展示是真的关掉（K2-A 那一版关不住图）。
  - 断言先红：forum/internal/media/channel_visibility_test.go（K2-A 的文件，本轮**改写**成新口径）两格：
    TestPaymentChannelImageFollowsDisplaySwitch（开关默认关 → 无关登录用户/游客拿不到；上传**之后**打开
    → 四种身份都拿到真图；再关回去 → 游客又拿不到）与 TestPaymentChannelImageTierIsNotPublic
    （images.visibility 必须是 1，不是 0）。旧行为下的红：
    channel_visibility_test.go:56: 无关登录用户 在作者**没开**渠道展示时不该拿到收款码图，实际 &{... Cache:true}
    与 channel_visibility_test.go:107: 收款码的档位必须是 VisibilityLogin(1)，实际 0。
  - 证据：go test ./internal/media/ -count=1 → ok forum/internal/media 20.840s；
    gofmt -l internal/media/ 空；go vet ./... exit 0。
  - 下一步：图文帖那一块的 AttachTopicImage（同一类问题：引用行写 private 且全仓无处翻档）。
  - 阻塞：无。
- [x] **图文帖第 1 步（后端）：配图的可见性跟着主题的审核态走（未过审不外泄、过审后可见）**
  - 现状核过：AttachTopicImage 的引用行写 VisibilityPrivate（service.go:259），而全仓**没有一处**翻档；
    正文里的图与列表封面因此对作者以外的人（含游客）永远是占位图。接口回 200 + 占位图，
    只看状态码发现不了（交接单 §5.2 那个病）。
  - 改法：canView 的 private 那一支加一条 topicImageLive —— topicImagePubliclyVisible() 一条 EXISTS：
    这张 hash 被 topic_images 引用，且所属主题 visibility='normal' AND review_state='approved'
    （判据与 forum 的公开流逐字一致，少一个谓词就是「未过审的配图能被外人取到」）。
    判定在**读路径**上，所以过审不需要重传图、也没有「翻档」要维护。
  - 断言先红：forum/internal/media/topic_image_visibility_test.go（新文件）
    TestTopicImageFollowsTopicReviewState（待审：作者拿得到 / 陌生人+游客拿不到；过审：四种身份都拿到；
    主题被删：又收回去）+ TestPrivateImageWithoutTopicStaysPrivate（没被主题引用的私有图不许被带出去）。
    旧行为下的红：topic_image_visibility_test.go:75: 无关登录用户 在主题过审后必须真拿到配图，
    实际 &{... Placeholder:[137 80 78 71 ...] Cache:false}。
  - 证据：go test ./internal/media/ -count=1 → ok forum/internal/media 25.388s；
    go test ./internal/reward/ ./internal/user/ -count=1 → 两个包都 ok（可见性口径没有外溢）；
    gofmt -l internal/media/ 空。
  - 下一步：前端配图的**上传 → 附加（POST /topics/{id}/images）→ 正文节点**这一段（web/src 里 zero 调用方）。
  - 阻塞：`web/src/routes/topic.tsx` 被 K2-C 拿着（它「下一步」写着要改它认 pending_draft）——
    配图在主题详情里的**展示**落点（topic-view.tsx 的 images 至今零渲染）我在下面第 3 步再定。
- [x] **图文帖第 2 步（前端）：配图的上传链路接通（lib/api/media.ts + MarkdownEditor.onUpload + compose 编辑态）**
  - 现状核过：`web/src` 里 **零调用方** —— 没有 media 客户端、编辑器插进正文的是 `blob:` 预览地址
    （刷新即失效，发布出去必然裂图）、compose 对编辑器传 `images={[]} onImagesChange={()=>undefined}`。
    所以「上传 → 附加到主题 → 正文节点」这一段是断的。
  - 改法：
    · **新文件** `web/src/lib/api/media.ts`：`attachTopicImage(topicId, file)`（multipart 字段名 `file`，
      与 `media/handler.go:170` 逐字一致）与 `detachTopicImage(topicId, hash)`；
    · `web/src/ui/rich/markdown-editor.tsx` 加一个可选 `onUpload`：给了它，点选与拖拽**两条路**都先传，
      正文节点里写的是**服务端地址**；不给就是老行为（`blob:` 预览，只留给不落库的演示场景）。
      这是最小改法：没有新控件、没有第二份上传实现（点选与拖拽本来就共用一条管线）；
    · `web/src/routes/compose.tsx` 编辑态接上 `onUpload`（上传 → `POST /topics/{id}/images` → 回 `/img/<hash>`），
      新帖态**不画**上传入口并写清原因（端点绑 topic，发新帖时还没有 id）；
    · `web/src/devroom/pages/18-compose/index.tsx` 也给它一个 `onUpload`（本地预览地址），
      让房间里的行为与真页面同形。
  - 为什么不做「通用图片通道」：那要给 media 加第二条上传端点 + 一个不绑主题的引用语义，
    而**产品上并不需要** —— 图片本来就是正文节点、sort=0 自动成为列表封面（后端 pgsql/topics.go:60），
    所以「先发帖、再回来配图」是端点的形状，不是缺功能。要补是另一块活，本轮不假造入口。
  - 断言：`web/src/lib/api/media.test.ts`（新文件，2 条）钉路径 / 方法与字段名 ——
    `POST /api/v1/topics/tp-1/images` + multipart `file` + 无 content-type（套 JSON 会让后端 readFormFile 400）；
    `DELETE /api/v1/topics/tp%2F1/images/<hash>`。另在 `routes/compose.test.tsx` 补一条
    「新帖态说清配图什么时候能加」（`compose-images-later`）。
  - 证据：`npx vitest run src/lib/api/media.test.ts` → 1 文件 / 2 用例通过；
    `npx vitest run src/routes/compose.test.tsx` → 3/3；`npx vitest run src/devroom/pages/18-compose` → 3 文件 / 16 用例。
  - 下一步：d5-content.md 的 §3.3 / §12.3 未决 1（与新拍板冲突那句）要改。
  - 阻塞：**`pnpm typecheck` 当前红，不是我的**：`src/routes/topic.tsx(26,28): error TS6133: 'searchUsers'
    is declared but its value is never read` —— 该文件在 **HEAD 里就已经**是坏的（K2-C 的提交 d019c4e 带的），
    K2-C 正在改它（它的「下一步」就是这一块），按规矩不抢。
  - 阻塞二：配图在**主题详情页的展示与删除**落点在 `web/src/routes/topic.tsx`（K2-C 拿着）与
    `devroom/pages/12-topic/types.ts`（`images: string[]` 目前**零渲染**）。我没碰这两个文件，
    在下面「留给 Lead / K2-C 的两行」里写清落点。
- [x] **拍板 §3.8：`VisibilityLogin` 死档 —— 选择「有人写」而不是「从值域删掉」**
  - 理由（二选一里必须写清的那一条）：它现在**有写入方**了 —— `AddPaymentChannel` 的引用行写的就是它
    （老站那一档，见上面第 1 步）。删掉它等于把收款码压回 private 或抬成 public，两者都被用户否掉：
    private 让打赏面板永远扫不出码（K2-A 报的缺口），public 让「关掉展示」关不住图（K2-A 被否的方案）。
    值域三档因此都是有主的：0 = 头像 / 封面 / 配图（过审后）/ 发帖前上传的图，
    1 = 收款码（读路径上看展示开关），2 = 帖子草稿配图（过审前）。
    机器证明：`TestPaymentChannelImageTierIsNotPublic` 断言收款码那一行 `images.visibility = 1`。
  - 证据：同上第 1 步的 `go test ./internal/media/`（ok 25.388s）与用例名。
  - 下一步：文档（d5 §3.3 / §12.3）。
  - 阻塞：无。

- [x] **文档：d5-content.md 与新拍板冲突的那几处改掉**
  - §3.3 整节重写：标题从「为什么收款码是 private」改成「档位是登录可见，闸是按渠道显示的展示开关」，
    写清「档位不在上传那一刻定死」、为什么要读老站、以及写死 public 为什么会让档位与开关脱钩。
  - §3.2 第 3 条：`visibility 固定 private` → `visibility 写 login` + 闸在作者侧开关（判定在读路径上）。
  - §3.4 的 canView 片段：补上 login 那一档的真实语义（不是「登录就可见」）与 private 那一档的
    帖子配图规则（所属主题公开后放行）；这正是本轮两处改动的落点。
  - §12.1 第 4 行（裁决表）与 §12.2 的清单项：从「改 private」改成「login + show_channels 闸」。
  - §12.3 未决 1：标记**已拍板**（用户选「必须显示，按渠道显示，参考老网站」），A/B/C 三个选项作废。
  - 顺带订正 `forum/internal/ent/schema/payment_channel.go` 的文件头（它还写着「图固定私有」，
    而 schema 注释就是下一个人查「这个档位是什么」的第一落点）。
  - 证据：`git diff` 只动这五处 + 一个 schema 注释；`git grep` 复核 d5 里不再有
    「收款码固定 private」的说法。
  - 下一步：收尾核对（两端全量）。
  - 阻塞：无。

## 留给 Lead / K2-C 的两行（我没碰他们的文件）

1. **配图在主题详情页的展示与删除**：落点是 `web/src/routes/topic.tsx`（K2-C 在途）与
   `web/src/devroom/pages/12-topic/types.ts` 的 `images: string[]`（**至今零渲染**，K2-A 也记过）。
   后端已经就绪：详情 DTO 给 `cover_hash`/`cover_width`/`cover_height`（sort=0 那张自动成为封面），
   删除走 `DELETE /topics/{id}/images/{hash}`（客户端已在 `lib/api/media.ts` 里写好）。
   还缺**一条读口**：没有任何端点能列出某帖的 `topic_images`（`GET /topics/{id}/images` 不存在），
   所以详情页要有图集就得先补这条读端点 —— 这是后端缺口，不是前端的懒。
2. **首屏预算只剩 1.2 KB**（收尾对照表 §7.6）：本轮前端改动全部落在 `/new` 与 `/t/*`（都已 lazy），
   没往首屏加东西；`lib/api/media.ts` 只被 `compose.tsx` import。
## 收工状态（2026-10-14 18:33）

- 四个提交：`f8c67e3`（L1 按渠道可见）、`5e3f4af`（图文帖后端：配图随主题审核态）、
  `8a8ff33`（图文帖前端：media 通道 + 编辑器 onUpload + compose 接线）、
  `ce407b9`（文档 + VisibilityLogin 死档定案）。工作区里**没有**我未提交的文件。
- 收工验证（当前工作区，含别人的在途改动）：
  · 后端：`gofmt -l .` 空 · `go vet ./...` exit 0 ·
    `go test ./internal/media/ -count=1` ok 25.4s · `./internal/forum/` ok 71.3s ·
    `./internal/reward/ ./internal/user/` 两个包 ok。
  · 前端：`pnpm typecheck` exit 0 · `npx vitest run` **37 文件 / 186 用例全绿**（基线 34/176 之上是本轮 2 条
    media 客户端用例 + 别人在途新增的文件）· 我改的 6 个文件 eslint **0 error**（2 条既有
    exhaustive-deps warning 落在我动过的 `markdown-editor.tsx` 上，但它们是**改动前就有**的那两条）。
  · 没跑 `pnpm check`（会 build 清 dist，同时刻只允许一个人跑）；没起常驻进程；出图台没占端口。
- **没有出图**，理由要与别处的「出图才算验过」一起看：本轮四条改动的可证伪面都在**读路径的授权判定**上
  （收款码开关 → 占位图 vs 真图；主题审核态 → 占位图 vs 真图；multipart 字段名；端点路径），
  Go 用例与前端断言逐格钉住了这四件事。真页面出图要真后端 + 真收款码数据（本机 `127.0.0.1:8080` 默认没起），
  图里看到的是同一份占位图逻辑，证明不了更多。**这是取舍，不是"验过了"** —— 谁要出图，先起后端。
- 已知的、我**没做**的两件（都写在上面的「留给 Lead / K2-C 的两行」里）：
  1. 主题详情页的配图图集与「删除配图」按钮 —— 落点在 K2-C 手里的 `routes/topic.tsx` 与
     `devroom/pages/12-topic/**`（`images` 至今零渲染）；且后端还缺 `GET /topics/{id}/images` 这条读口。
  2. 首屏预算只剩 1.2 KB —— 本轮前端改动全在 lazy 路由下，没往首屏加东西。
### 收工后的两条追加观察（18:36）

1. **本文件提到的「我的四个提交」可能在 `git log --oneline` 里不连续** —— 同一时刻有两个 agent 在提交
   （K2-B / K2-C），历史是交错的。核过的判据不是「排在第几条」，而是
   `git merge-base --is-ancestor <我的提交> HEAD` 三条全 exit 0（f8c67e3 / 8a8ff33 / ce407b9）。
   工作区里我的文件也都干净。
2. **`web/src/ui/rich/markdown-editor.tsx` 又被 K2-C 改了**（未提交）：它加了一个可选 `onQueryChange`
   用于 @ 提及候选的按需查询（拍板第三轮第 4 条）。本轮**不抢**——我的 `onUpload` 与它的 `onQueryChange`
   是同一份 props 列表里的两个可选 prop，交集只有类型声明那一段，合并时注意别把任一方丢掉即可。
   我的那一版已在提交 8a8ff33 里（`onUpload` 的两条路：拖拽与点选）。

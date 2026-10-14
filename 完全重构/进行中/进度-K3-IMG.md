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

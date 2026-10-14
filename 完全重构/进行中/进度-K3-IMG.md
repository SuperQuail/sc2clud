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

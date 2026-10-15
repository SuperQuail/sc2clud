# 进度 · FIX-VLM（让 AI 审核真的读图 + 管理端预览/连通性测试按「开图之后」的形状）

> 权威事实：`完全重构/进行中/10-dev排查-缺陷清单.md` §1h/D33 与「D33 ③ 权威事实」（DeepSeek 官方 vision 文档已核对）。
> 作用域：`forum/internal/platform/ai/**`、`forum/internal/aireview/**`、迁移 0053 起、
> 以及管理端预览/连通性测试屏（`web/src/devroom/pages/15-admin/screens/ai*.tsx`、`web/src/routes/admin/**`）的**增量**。
> **payload 字段名以本文件的「契约」一行为准**（别的包要照着渲染，别自己猜）。

## 契约（POST /admin/ai/payload 的回执 = 下一次真发出去的那一份，dry-run 不外呼）

```
source topic|probe / topic_id / title / trigger / open_reports
system / user_prefix / user_title / user_body / user_text
images[] : {position, floor, hash, mime, bytes, sent, note}   ← 顺序 = 页面顺序
image_count       真发出去的张数
image_skipped     被上限截掉、没发的张数
image_bytes       发出去的图原始字节合计
image_limit / image_max_bytes   上限本身（界面要能解释「为什么只有 4 张」）
image_read_failed true = 有图读不到 → 这次转人工
model / max_output_tokens / strict_mode / tool_name / categories
```

`POST /admin/ai/test` 入参新增可选 `topic_id`：给了就**真发一次这条帖子的 payload（带图）**，
回执 = TestView + {topic_id, image_count, image_skipped, images[]}；不给 = 原来的连通性样例。

## 步骤

- [x] ① `platform/ai`：`Judge` 支持 content 块数组（有图 = `[text, image_url…]`，无图 = 与从前逐字同形）
  - 证据：先红 —— 新用例 `TestJudgeSendsImageContentParts` / `TestJudgeKeepsPlainTextUserWithoutImages` 写完后
    `go test ./internal/platform/ai/` → `FAIL forum/internal/platform/ai [build failed]`（`undefined: JudgeImages`）；
    实现后同一条命令 → `ok forum/internal/platform/ai 2.100s`。`go vet` 空、`gofmt -l` 空。
    断言打在**线上形状**上（解析抓到的请求体：`messages[1].content` 必须是块数组、第 2 块是 `image_url` 且 URL 逐字等于 data URL），
    所以「接了图但发成纯文本」这条也会红。
  - 下一步：`forum/internal/media` 加「按 hash 读字节」的站内读口（复用 `image.Store.Open`，不自己拼路径）；迁移 0053 给
    `review_events` 加 `image_count`/`image_skipped`；`aireview` 取 `topic_images`（页面顺序）→ 上限 → 附到 user。
  - 阻塞：无（但见下「现场」一条）。
- [x] ② 迁移 0053（`review_events.image_count` / `image_skipped`）+ media 的站内读字节口
  - 证据：`forum/migrations/postgres/0053_ai_review_image_counts.{up,down}.sql`；
    `media.Service.ReadImageBytes`（同一个 `image.Store.Open`，**不自己拼路径**、不过 `canView`、不回落占位图；
    32 MiB 只是内存闸门，业务上限在 aireview）。`go build ./...` 空输出。
  - 下一步：见 ③。
  - 阻塞：无。
- [x] ③ aireview 取图/上限/转人工/留痕 + 翻旧断言（`images.go` 一个文件装全部决定）
  - 证据：`go test ./internal/aireview/ ./internal/media/ ./internal/platform/ai/ -count=1` → 三个包全 ok（19.8s / 出口码 0）。
    先红：新断言写完先跑，红在「带图帖附了 0 张」与「review_events 没有 image_count 列」（迁移 0053 之前 42703）。
    旧断言 `TestOutboundPayloadHasNoImageField` **拆成两条**（这正是任务要求的那两条）：
    `TestOutboundPayloadCarriesImageBlocks`（带图帖必有 image 块 + 记 1/0 + model 非空）与
    `TestOutboundPayloadHasNoImageBlockWithoutImages`（无图帖 0 张、**一次盘都不读**、文本里不许有 data:image）。
    另加四条：上限截断计数（6 张 → 发 4 截 2）、超单张上限只截不转人工（1/1 且判定照常落库）、
    **读图失败 → 转人工**（零外呼/零事件/状态仍 pending/不返回错误/写 last_error）、
    有图超时抬到 60s 且超时原样报 `ai.ErrTransport`（可重试，绝不落成判定）。
    `gofmt -l .` 空。
  - 下一步：见 ④。
  - 阻塞：无。
- [x] ④ `/admin/ai/payload` 回图片块 + `/admin/ai/test` 支持带帖试跑
  - 证据：`PayloadView` 新增 `images[] / image_count / image_skipped / image_bytes / image_limit /
    image_max_bytes / image_read_failed`；`TestView` 新增 `topic_id / image_count / image_skipped / images[]`；
    `Service.TestTopic` 走**与真判定同一条组装**（含图）但一个字都不落库。
    顺带修了 FIX-AI2 那条已经写好、正红着的用例逼出来的真缺陷：`handler.payload` 的空 body 分支没实现
    （注释写着"一个字节都没有不是错误"，代码却直接 Fail → 500），补 `!errors.Is(err, io.EOF)` 后
    `TestPayloadEndpointIsWiredAndReadsTheRealTopic` 转绿。
  - 下一步：见 ⑥（管理端渲染）。
  - 阻塞：无。
- [x] ⑤ app 接线：`aireview.New(in.Pool, nil, m.Media, …)`
  - 证据：`forum/internal/app/modules.go` 一行 + 注释说明「传 nil 不崩，但带图帖一律转人工 = 这个功能没接线」。
  - 下一步：见 ⑥。
  - 阻塞：无。
- [x] ③b 线上形状的最终证据（真外呼 + 假上游抓请求体）
  - 证据：`TestImagesReachTheWireAsDataURL`：judge 传 nil（= 真 `ai.JudgeImages`）+ base_url 指向 httptest 假上游，
    断言上游收到的 `messages[1].content` 是 `[text, image_url]`，且 `image_url.url` **逐字等于**
    `data:image/webp;base64,` + media 里那一份字节（1024 个 0xAB），判定照常落库、review_events 记 1 张。
    前面那批用例注入的是假外呼 —— 它们只证明「图交给了外呼口」；这一条才证明「真的编成了 data URL 上线」。
  - 下一步：见 ⑥。
  - 阻塞：无。
- [ ] ⑥ 管理端增量（预览显示 image 块、样例可见可编辑、带图验证出图）
  - **现场变化（09:53 实测）**：FIX-AI2 已经在改这批文件了 —— `web/src/lib/api/admin.ts` 与
    `admin-types.ts` 已在途（`fetchAiPayload` / `testAiConfig(probe, topicId)` / `AiPayloadImage` /
    本文件定的那 7 个 image 字段**全都对齐了我的字段契约**），并且 09:53:03 新建了
    `web/src/devroom/pages/15-admin/screens/ai-payload.tsx`（当时 18 秒前）。
    按 Lead 的更正（"别碰 platform/ai 与 aireview 的请求组装"是给它的、预览屏归它），
    **我不去抢这两个文件** —— 抢了就是把它的在途工作冲掉。我这一包的交付边界就落在后端，
    前端那半由它完成；冲突点记在这里，Lead 若要我做请说一声（我按它那一刻的版本增量改）。

## 两处必须写清的取舍

1. **data URL 而不是公网 URL**：官方另一条路要求图片「60 秒内能被服务端取回」的**公网地址**，
   而本站的 `/img/<hash>` 在 dev / 内网里外部取不到 ⇒ 只能内联。代价是 base64 计入 48 MiB 请求体上限
   （4×2 MiB×4/3 ≈ 10.7 MiB，离上限很远）。**真上线若要走 URL，得另配一个公网可达的图片域** —— 那是运维动作。
2. **重试次数保持 2，没有跟着图一起 +1**：任务书写的是「timeout_ms 与重试跟着调」，我调了前者
   （有图时超时下限 60s），**没有调后者**，理由是可查的：`max_retry` 在**入队那一刻**就写进 jobs 表
   （`forum/topics.go:382` 与 `aireview/util.go:14`，两处都是硬编码 2），而那时**还不知道这条帖有没有图**
   —— 要按图区分就得改队列契约（入队前多查一次图集）或者整体 +1。整体 +1 的代价是真实的：
   每次重试都会**重发一遍全部图片**，一次读不到文件的调用会被重发 4 遍。所以只调超时，
   并保留既定的「失败 → 转人工」语义（用例 `TestImageCallGetsLongerTimeoutAndTimeoutIsNotAVerdict`
   钉住：超时是可重试失败，绝不落成判定）。**这是与任务书的一处有意偏差，写在这里备查。**

## 现场（开工时的实测，不是推的）

- `完全重构/进行中/进度-FIX-VLM.md` 开工时**不存在**（Lead 让我读它的「下一步」，那一步没有落点）→ 字段名由本文件定义。
- `forum/internal/aireview` 开工时**编译不过**：`preview_test.go` 报一批 `imported and not used`
  （有别的包正在改它）。我按纪律不动别人的在途改动，先做不冲突的文件。

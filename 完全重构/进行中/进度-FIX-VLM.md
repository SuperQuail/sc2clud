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
- [ ] ⑥ 管理端增量（预览显示 image 块、样例可见可编辑、带图验证出图）

## 现场（开工时的实测，不是推的）

- `完全重构/进行中/进度-FIX-VLM.md` 开工时**不存在**（Lead 让我读它的「下一步」，那一步没有落点）→ 字段名由本文件定义。
- `forum/internal/aireview` 开工时**编译不过**：`preview_test.go` 报一批 `imported and not used`
  （有别的包正在改它）。我按纪律不动别人的在途改动，先做不冲突的文件。

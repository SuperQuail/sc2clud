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
- [ ] ② 迁移 0053 + media 读口
- [ ] ③ aireview 取图/上限/转人工/留痕 + 翻旧断言
- [ ] ④ preview/payload 端点带上 image 块 + `/admin/ai/test` 支持带图试跑
- [ ] ⑤ app 接线
- [ ] ⑥ 管理端增量（预览显示 image 块、样例可见可编辑、带图验证出图）

## 现场（开工时的实测，不是推的）

- `完全重构/进行中/进度-FIX-VLM.md` 开工时**不存在**（Lead 让我读它的「下一步」，那一步没有落点）→ 字段名由本文件定义。
- `forum/internal/aireview` 开工时**编译不过**：`preview_test.go` 报一批 `imported and not used`
  （有别的包正在改它）。我按纪律不动别人的在途改动，先做不冲突的文件。

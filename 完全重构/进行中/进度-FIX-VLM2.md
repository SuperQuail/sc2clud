# 进度 · FIX-VLM2（D34：连通测试的样例可自配图片）

> 派单：/admin/ai/test 与 /admin/ai/payload 接受 multipart（probe 文本 + ≤4 张 file），图片只在内存里走；
> JSON 路径保持原样；上限沿用带帖路径同一套常量；前端 ProbeEditor 选图即重算干跑。必读纪律见 10-dev排查-缺陷清单.md §0/§1i。

- [x] 后端：两个端点加 multipart 形态（probe + 0..4 张 file；在其内存里嗅探、上限截断、逐张记 note，不落库）
  - 证据：新用例先红（multipart 打进旧 handler 是 400 common.invalid_input「请求体格式不正确」，4/4 FAIL）→ 实现后 `go test ./internal/aireview/ -count=1` 全包 PASS（ok，23.2s；旧 JSON 三条 TestTestEndpointAcceptsProbeOverrideAndEmptyBody / TestPayloadEndpointIsWiredAndReadsTheRealTopic / TestProbeSampleIsReadableAndOverridable 原样绿）；gofmt -l internal/aireview 无 diff；go vet ./internal/aireview 干净
  - 下一步：前端 file-picker.tsx（新）+ registry 登记，ProbeEditor 选图/移除/拒绝原因
  - 阻塞：无

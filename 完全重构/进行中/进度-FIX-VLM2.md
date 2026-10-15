# 进度 · FIX-VLM2（D34：连通测试的样例可自配图片）

> 派单：/admin/ai/test 与 /admin/ai/payload 接受 multipart（probe 文本 + ≤4 张 file），图片只在内存里走；
> JSON 路径保持原样；上限沿用带帖路径同一套常量；前端 ProbeEditor 选图即重算干跑。必读纪律见 10-dev排查-缺陷清单.md §0/§1i。

- [x] 后端：两个端点加 multipart 形态（probe + 0..4 张 file；在其内存里嗅探、上限截断、逐张记 note，不落库）
  - 证据：新用例先红（multipart 打进旧 handler 是 400 common.invalid_input「请求体格式不正确」，4/4 FAIL）→ 实现后 `go test ./internal/aireview/ -count=1` 全包 PASS（ok，23.2s；旧 JSON 三条 TestTestEndpointAcceptsProbeOverrideAndEmptyBody / TestPayloadEndpointIsWiredAndReadsTheRealTopic / TestProbeSampleIsReadableAndOverridable 原样绿）；gofmt -l internal/aireview 无 diff；go vet ./internal/aireview 干净
  - 下一步：前端 file-picker.tsx（新）+ registry 登记，ProbeEditor 选图/移除/拒绝原因
  - 阻塞：无
- [x] 前端：new file-picker.tsx（headless、不加工）+ registry 登记薄
  - 证据：src/devroom/pages/15-admin/screens/ai-probe.test.tsx 5 用例红→绿（选不上图/联不上 sampleNotes 先红）；同行 1440 宽可见「添加图片」钮
  - 下一步：admin.ts / routes/admin/ai.tsx 接 FormData
  - 阻塞：无
- [x] 前端：admin.ts 与容器走 FormData；ProbeEditor 选图即重算
  - 证据：src/routes/admin/ai-files.test.tsx 2 用例红→绿（payload multipart 2 部件、test 走 FormData 且 file 部件 2 枚）；全量 vitest 61 文件/301 用例全绿（基线 59/294 不变不碰红）
  - 下一步：DevRoom 出图 1440/390（双图、payload 图块、回执明细）
  - 阻塞：无
- [x] 出图并看图（1440 与 390，DiffRoom→DevRoom？不：DevRoom 15-admin/ai，dsh 已看）
  - 证据：CDP 出图（shots/fixvlm2-shot.mjs，非 agent-browser）：probe-files(1440/390) 双图 chips + 第 2 张 3.4 MB 红字「单张 3.4 MB 超过上限 2.0 MB，这一张没发」；receipt 两对图有「判了 2 张图」药丸 + 「只走一条请求不落库」注脚；payload 图块三行含「不发给模型 · 单张 3.3 MB 超过上限」（1440/390）—— 均有自证标记「FIX-VLM2 2026-10-15 @devroom 15-admin/ai (D34)」
  - 下一步：无（D34 收口；搭配运行命令：cd web → pnpm typecheck && pnpm lint && npx vitest run；cd forum → gofmt -l . + go vet ./... + go test ./internal/aireview/ -count=1）
  - 阻塞：无

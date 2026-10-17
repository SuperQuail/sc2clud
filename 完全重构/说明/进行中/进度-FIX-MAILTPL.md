# FIX-MAILTPL 进度（D37 邮件文案可自定义）

- [x] 迁移 0054_mail_templates + platform/mail 自定义模板编译件（Override/CompileTemplate/Compiled.Render/Builtin）
  - 证据：go vet ./internal/platform/mail 先红（undefined: Override）→ go test ./internal/platform/mail/ ok（TestCompileTemplateRejectsBadTemplate 5 组错误原话带行位；TestBuiltinSourcesRoundTrip 回落同源；TestCompiledRenderPartial 部分覆盖）
  - 下一步：internal/mail —— pgsql 四条模板查询 + Service 模板缓存 + tasks.go render 接 override
  - 阻塞：无

- [x] internal/mail 全链（缓存/PUT 编译拒收/DELETE 恢复内置/preview 样本转义）
  - 证据：templates_test.go 先红（undefined: mail.TemplateInput）→ go test ./internal/mail/ ./internal/mail/pgsql/ -count=1 ok（TestPutTemplateChangesPreviewAndDelivery 走真投递链两封对比=缓存失效生效；TestMailTemplateHTTPContract 400+fields 带 html:2 行位；TestDeleteTemplateRestoresBuiltin 删→内置→再入表→自定义→再删幂等）；gofmt -l 干净、go vet ./... 零输出
  - 下一步：前端 —— lib/api/admin.ts 类型与四条请求 + screens/mail-tpl.tsx View + room + routes/admin/mail-tpl.tsx 宿主 + nav 列表项
  - 阻塞：无

- [x] 前端全链（类型/请求/View/房间/宿主/导航）+ 用例先红后绿 + 出图
  - 证据：mail-tpl.test.tsx 先红（previewBusy undefined）再 6/6 绿（转义证据=srcdoc 含 &lt;script&gt; 且 document 无任何 script 节点、保存送全量三份、fields 定位 notice:html:2、恢复内置过确认、取消不动）；突变成 dangerouslySetInnerHTML 直注入 → 转义用例红 → 回滚复绿；pnpm typecheck ok / lint 邮件模板相关零问题（改掉手写 <button>）/ npx vitest run 全仓 62 文件 307 用例全绿
  - 出图（cdp-shot @5337，vite preview:dev 后台起、CDP_PORT=9328 chrome 按 PID 自杀清理；端口 5283 撞 QQ.exe 的 IPv4 监听换 5337）：web/shots/fixmailtpl/1440-1-editor.png（四行 pills + 等宽编辑框）、1440-2-preview-iframe.png（iframe 内 123456 + 样本昵称字面量、并列 <pre>）、1440-3-confirm-dialog.png（恢复内置确认弹层）、1440-4-after-reset.png（回退后 pill=内置×3 + 编辑框回显内置源）、390-1-editor.png、390-2-preview-iframe.png —— 全部逐张看过
  - 下一步：收尾 —— 视门禁（不跑 pnpm check，Lead 收口跑）与交付报告
  - 阻塞：编译错误就地显示的**实机截图**未拍（房间不发请求；fields→就地显示已由 mail-tpl.test 的 notice:html:2 用例 + 后端 TestMailTemplateHTTPContract 400+fields 钉住；真机验证需要对一个起了后端的实例走一次 400）

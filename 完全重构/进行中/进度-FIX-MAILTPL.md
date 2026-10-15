# FIX-MAILTPL 进度（D37 邮件文案可自定义）

- [x] 迁移 0054_mail_templates + platform/mail 自定义模板编译件（Override/CompileTemplate/Compiled.Render/Builtin）
  - 证据：go vet ./internal/platform/mail 先红（undefined: Override）→ go test ./internal/platform/mail/ ok（TestCompileTemplateRejectsBadTemplate 5 组错误原话带行位；TestBuiltinSourcesRoundTrip 回落同源；TestCompiledRenderPartial 部分覆盖）
  - 下一步：internal/mail —— pgsql 四条模板查询 + Service 模板缓存 + tasks.go render 接 override
  - 阻塞：无

- [x] internal/mail 全链（缓存/PUT 编译拒收/DELETE 恢复内置/preview 样本转义）
  - 证据：templates_test.go 先红（undefined: mail.TemplateInput）→ go test ./internal/mail/ ./internal/mail/pgsql/ -count=1 ok（TestPutTemplateChangesPreviewAndDelivery 走真投递链两封对比=缓存失效生效；TestMailTemplateHTTPContract 400+fields 带 html:2 行位；TestDeleteTemplateRestoresBuiltin 删→内置→再入表→自定义→再删幂等）
  - 下一步：前端 —— lib/api/admin.ts 类型与四条请求 + screens/mail-tpl.tsx View + room + routes/admin/mail-tpl.tsx 宿主 + nav 列表项
  - 阻塞：无

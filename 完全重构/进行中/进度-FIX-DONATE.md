# 进度 · FIX-DONATE（D22 / D23 / D24）

> 作用域：`web/src/devroom/pages/11-profile/**`、`web/src/ui/**`、`web/src/routes/{profile,settings}.tsx`、
> `web/src/lib/api/rewards.ts`、`forum/internal/**`（仅 D24 那一处默认值）、本文件。

- [x] 2026-10-15 第一步：D24 后端 —— **上传收款码即默认显示**（`show_channels` 由上传写 true）
  - 证据：先写会红的用例 `forum/internal/media/payment_channel_default_test.go`，旧行为下两条都红：
    `上传收款码后 show_channels 必须是 true …实际匹配行数 0` / `上传即默认显示：游客必须拿到真图，实际是占位图`；
    改 `repo.go` 的 `turnChannelDisplayOn`（upsert，由 `service.go:AddPaymentChannel` 在同一个事务里调）后：
    `go test ./internal/media/ -count=1 -run TestPaymentChannel -v` → 5/5 PASS；
    整包 `go test ./internal/media/ -count=1` → `ok forum/internal/media 22.704s`；`go vet ./internal/media/` → 0；`gofmt -l .` → 空。
    `channel_visibility_test.go` 的「开关默认关」那一步改成**显式关掉**（本条要证的是关掉之后真取不到）——
    默认值不再是关，测试里的旧断言是那条改动的另一半。
  - 下一步：前端 D22 —— 把 `devroom/pages/11-profile/payment-channels.tsx` 拆成 prop 驱动的 View + 数据 hook，
    再让 `sponsor-card.tsx` 那颗「设置我的收款码」就地弹层（复用 `@/ui/cover-picker` 的 Dialog 用法 + `image-uploader`），
    不跳 `/settings#payment-channels`。
  - 阻塞：无

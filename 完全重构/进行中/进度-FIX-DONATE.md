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

- [x] 2026-10-15 第二步：D22 —— 那颗「设置我的收款码」**就地弹层**（不跳设置页），版面与设置页那一格同源
  - 证据：`sponsor-card.test.tsx` 先红（旧行为那颗按钮是 `<a href="/dev/settings#payment-channels">`：
    断言 `entry.closest('a')` 为 null 与 `findByRole('dialog')` 都过不去）→ 改完
    `npx vitest run src/devroom/pages/11-profile/` = **17 passed (4 files)**；
    形状：`payment-channels.tsx` 只剩 `PaymentChannelsView`（只吃 props）+ `PaymentChannelsDialog` + 设置页那张卡，
    取数/写动作搬到新的 `payment-channels-hook.ts`（`useMyPaymentChannels(enabled)`），
    「我的打赏记录」搬到 `records-panel.tsx`（弹层里没有它的落点）；
    宿主两条：`routes/settings.tsx` 与 `routes/profile.tsx`（后者给 `SponsorCard` 传 `editor`，看别人时不传 = 没有管理入口）。
    出图（看图确认，图里读得到标记）：`shots/fix-donate-d22-room-b.png`（1440：弹层里列表/渠道名/上传口/可见性开关全在）、
    `shots/fix-donate-d22-room-390-b.png`（窄屏：两列码 + 按钮不截断，500px 是 headless Chrome 的最小窗宽）。
    另：`src/test/setup.ts` 补了 jsdom 缺的 `<dialog>.showModal/close`（Ring 的 Dialog 依赖它；补的是浏览器本来的行为）。
    D24 的默认显示在界面上的落点也在这张弹层里：开关那一行写明「开着 = 别人主页与帖子右栏都能看到」。
  - 下一步：D23 —— 头像选图后弹裁剪框。新件放 `web/src/ui/rich/`（`image-crop.ts` 纯几何 + `image-cropper.tsx` 弹层），
    由 `image-uploader` 的 `crop` 开关接上（`avatar` 形态才弹）；`routes/profile.tsx` 与 `routes/settings.tsx` 两处头像共用同一条路，
    看别人主页时不出现（入口本来就只在 `isSelf`）。
  - 阻塞：无

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

- [x] 2026-10-15 第三步：D23 —— 头像选图后**弹裁剪框**选启用区域（复用房子件 Dialog + 现有图片管线，无新依赖）
  - 证据：几何先钉住（`src/ui/rich/image-crop.test.ts` 5 条）——把 `cropRect` 故意改坏（`size` 乘 1.37）后
    「取的区域是图片内的正方形」「放大之后取的是一块更小的区域」「取的区域是原图内的正方形」三条**真的红**，改回即绿；
    弹层交互 `src/ui/rich/image-cropper.test.tsx` 4 条（drawImage 的 src 矩形是方、在图内、缩放真的进裁切、1x/4x 到顶）。
    接线两处：`avatar-setting.tsx`（设置页/房间那格）与 `routes/profile.tsx`（本人主页那颗头像，headless 形态）；
    裁完仍走 `image-pipeline`（长边 256、目标 64KB）→ `POST /me/avatar`，传输那一段一行没改。
    「看别人主页时不出现」压实到 DOM：不挂 `isSelf` 那层时新断言 `input[type=file]` 数量 0 **红**（实测），挂上即绿。
    出图看图：`shots/fix-donate-d23-room-1440.png`（框里是圆的头像可视区 + 缩小/放大/百分比/复位/取消/就用这一块）、
    `shots/fix-donate-d23-room-zoomed.png`（点两次放大 → 150%，图真的变大）。
    新件按规矩登记进 `devroom/registry.ts`（`image-cropper`，page 11-profile）→ `check-controls` 报「49 个控件」。
  - 下一步：**无（本包三条 D22/D23/D24 都已提交）**。留给 Lead 的两处口径：
    ① 出图脚手架 —— 上面 4 张图都是 DevRoom（`devroom.html?page=11-profile`），产品页那两张没出
    （本机没有后端，产品页要真数据；按交接单 B8 的结论走）；② 设置页 `/settings#payment-channels` 这个锚点还在，
    但内容改成了「页内那一格」，锚点本身仍可用（`routes/settings.tsx` 里那一节没搬走）。
  - 阻塞：无

## 收口状态

| 条 | 状态 | 提交 |
|---|---|---|
| D24 收款码上传后默认显示 | 完成（后端默认值 + 界面文案） | `89a36b0` |
| D22 设置我的收款码 → 就地弹层 | 完成（View 与设置页同源） | `502ed1b` |
| D23 头像选图后裁剪框 | 完成（纯几何 + 房子件 Dialog） | `01f4e7b` |

三条各自的「先证明会红」证据都在上面三段的「证据」里。**没有新增迁移**：D24 走的是「上传那一笔把自己那行写 true」，
不需要改 0011 的 DEFAULT（也不需要 0052），所以迁移号一次都没占。

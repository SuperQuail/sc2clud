# 进度 · FIX-IMG（D1 / D2 / D3：图片与上传）

> **作用域**（缺陷清单 §2 的派发）：`web/src/ui/rich/image-uploader.tsx`、`web/src/ui/rich/image-pipeline.ts`、
> `web/src/devroom/pages/03-navigation/**`、`web/src/devroom/pages/11-profile/avatar-setting.tsx`、
> `web/src/routes/_parts/layout.tsx`、本文件。
> **不许改**：`web/src/app/router.tsx`、`web/src/app/shell.tsx`、`web/src/main.tsx`（Lead 专属）。
> **基线**：前端 38 文件 / 189 用例（本轮开工时 HEAD = d9a865e，`npx tsc --noEmit` 干净）。
> **协议**：每小步一个提交、只 add 自己改的文件、同一提交更新本文件（四行：做了什么/证据/下一步/阻塞）。
> **方法（清单 §0）**：页面 = prop 驱动的 View（`devroom/pages/<页>`，只吃 props、不 fetch、不认路由）
> + 极薄宿主（`routes/`，只取数与传参）。顺序固定：① 改 View → ② DevRoom 出图 → ③ 宿主跟着改 → ④ 产品页出图。

## 记录

- [x] **D1（收款码 1.3MB 被直接拒 + 提示出现两次）：上传器的「体积上限」与「压缩目标」拆成两个 prop**
  - 根因（与清单的「待核」一致，已核实）：`ImageUploader` 只有 `maxSize` 一个数，
    而调用点把**服务端的硬上限**（512KB）当成了它 → `planImages` 在**压缩之前**就把 1.3MB 判成「太大」当场退掉。
    它同时也是「提示出现两次」的出口：控件内部 `setError(msg)` 画一行，宿主 `onError` 又画一行。
  - 改法（最小）：`image-uploader.tsx` 新增 `targetBytes`（压缩后的成品目标，透传给 `processImage`），
    默认按形态取（avatar → AVATAR_TARGET，其余不设）；**删掉控件内部那行 error**（提示归宿主一份）；
    `payment-channels.tsx` 改喂 `maxSize={AVATAR_MAX_BYTES}` + `targetBytes={512KB-32KB}` 并删掉自己那行重复 error；
    `avatar-setting.tsx` 补一行 `onError` 的提示位（它是头像位的宿主，原先靠控件内部那行）。
  - 断言先红：`web/src/ui/rich/image-uploader.test.tsx`（新文件，2 条）—— 改之前
    `1.3MB 的收款码图被压缩后收下` 红（`queryByRole('img', {name:'已选头像'})` 为 null：图根本没加进来）。
  - 证据：`npx vitest run src/ui/rich src/devroom/pages/11-profile` → 5 文件 / 23 用例全绿；
    `npx tsc --noEmit` exit 0；`npx eslint`（4 个改动文件）exit 0。
  - 下一步：`web/src/devroom/pages/11-profile/payment-channels.tsx` 出图（DevRoom 11-profile 的「赞赏与收款码」那一格，
    选一张 1.3MB 的图 → 应看见缩略图 + **一行**提示）；产品页 `/settings#payment-channels` 出图对照。
  - 阻塞：无。

## 待办

- [ ] **D1 出图**：DevRoom 11-profile（上传 1.3MB 的收款码）→ 产品 `/settings#payment-channels` 对照。
- [ ] **D2 顶栏头像裂图**：根因已定位（见下面「结论」），**修法在后端 / Lead 的 `shell.tsx` 之外**，需要写进阻塞。
- [ ] **D3 左侧分区列表与非分区页面没有图片**：`BoardRail` 还是 `routes/_parts/layout.tsx` 里的**版面代码 + 查询**，
      要按 §0 拆成 View（`devroom/pages/03-navigation/`）+ 极薄宿主（`routes/_parts/layout.tsx` 只取数传参）；
      数据侧 `GET /api/v1/boards` 的 `cover_hash` **全是空串**（实测，见下），要在数据侧给回填方案。

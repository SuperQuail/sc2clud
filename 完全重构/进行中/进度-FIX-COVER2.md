# 进度 · FIX-COVER2（默认封面 = 美术资产里的一张弥音）

范围：`web/src/ui/**`（默认封面件）+ 各封面位的 View。派单：用户原话「应该有一张默认封面图，从当前美术资产里找一张弥音的图」。

## 选中：`web/public/art/miyin-portrait-320.webp`

| 判据 | 数 |
| --- | --- |
| 封面位是**宽幅**（卡片 16:9 / 后台 96×56 / 侧栏 20–56 方格），而 miyin/** 全是方图 | 宽幅下靠 `object-cover` 居中裁 |
| 裁到 16:9（256×144）后主体还在不在 | portrait 是**正面居中胸像** → 两只眼睛都在、脸在正中；smile-160 在 4:1 窄条上只剩一条闭眼弧线；welcome-400 在小方格里脸被切掉下半 |
| 铺在卡片上会不会糊成白纸 | 实测 256×144 的亮度/对比：portrait L=198 sd=35；welcome 228/26；wink 236/21；smile 210/28 —— 淡彩几张对比度不够，看着像「图没加载出来」 |
| 够不够大 | 320×320（14.2KB）。卡片封面位 256 逻辑像素、2x 屏 512 → 是最小够用那档，与 TopicCover 的 `MIN_COVER_WIDTH=320` 同一条尺子 |

出图：`shots/fixcover2/00-contact-sheet.png`（四屏对照）、`e-chosen-art-portrait-320.png`（选中那张单拍）。

## 步骤

- [x] ① 默认封面件落地 + 三个封面位换过去（首页卡片族 / 分区左栏 / 帖子页左栏 —— 后两者是同一个 BoardRail View）
  - 证据：先红 —— `npx vitest run src/ui/topic/default-cover.test.tsx` → `Failed to resolve import "./default-cover"`；
    `board-rail.test.tsx` → `AssertionError: expected '皇' to be ''`；`home.test.tsx` 两条 → `expected '/art/miyin/wink-520.webp' to be '/art/miyin-portrait-320.webp'`（帖子自己那张封面）与 `expected '/art/miyin-portrait-160.webp' to be '/art/miyin-portrait-320.webp'`（cover_width 太小的回落）。
    后绿 —— 四套 31 tests 全过（`default-cover 3 / board-rail 4 / home 12 / topic-view 12`），加 18-compose 共 47 passed。
    改的文件：`web/src/ui/topic/default-cover.tsx`(+test)、`14-home/topic-parts.tsx`、`03-navigation/board-rail.tsx`(+test)、`12-topic/topic-view.test.tsx`。
  - 下一步：后台列表缩略图无封面时（`15-admin/screens/boards.tsx` 的 32×32 行缩略图与 96×56 资料预览）换 `DefaultCover`；然后出图。
  - 阻塞：无（提交 `aeeeea6`）

- [x] ② 后台分区管理两处缩略图换 `DefaultCover` + 四屏出图（首页卡片 / 分区左栏 / 后台列表 / 390 窄屏）+ 选中那张图单拍
  - 证据：先红 —— 把实现临时改回旧版（`ImageIcon` 虚框）跑 `boards.test.tsx` → `AssertionError: expected [] to have a length of 2 but got +0`；恢复后 4 tests 绿。
    出图（`CDP_SIZE=1440,900` / `390,844`，端口 5202 静态服务 + CDP 9403–9408，按 PID 关）：
    `shots/fixcover2/00-contact-sheet.png`、`a-home-default-cover-1440.png`、`b-board-rail-1440.png`、`c-admin-boards-1440.png`、`d-home-390.png`、`e-chosen-art-portrait-320.png`。
    看图结论：卡片上默认封面铺满 16:9、脸在正中、标题在下方卡体上（不压图）；左栏 20×20 与后台 32×32 都能认出是一张人脸；390 窄屏不裂不挤。
    全量：`npx vitest run` = 287 passed（2 个套件收集失败，见阻塞）；`pnpm gate:ui`/`gate:controls`/`gate:urls` 三条全绿。
  - 下一步：无（本轮范围收口）—— 收尾时把 `BoardCover` 已经用不到的两个 prop（`slug`/`name`，虚线框/首字那套留下的）删掉，三个调用点（board-rail 自己、12-topic/board-summary、18-compose）跟着改传参。—— 若要动「用户主页壁纸的默认」（profile.tsx 现回落 `starcraft/sc2-battle.webp`）需用户重新拍板，那是横幅不是封面。
  - 阻塞：`src/lib/api/admin.ts:409` 有人把 `in` 当参数名（`fetchAiPayload(in: {...})`），**在当前工作区里是解析错误** —— 于是 `pnpm typecheck` 有 7 条 TS 错、`pnpm lint` 1 条 error、`src/routes/admin/ai.test.tsx` 与 `src/lib/api/admin.test.ts` 两个套件收集失败。全库这套错**只落在这一个文件**（`pnpm typecheck | Select-String 'error TS'` 去重后只有 `src/lib/api/admin.ts`），与本包无关，已按纪律不碰（不在我的作用域）。

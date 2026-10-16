# 进度 · FIX-COVER2（默认封面 = 美术资产里的一张弥音）

范围：`web/src/ui/**`（默认封面件）+ 各封面位的 View。派单：用户原话「应该有一张默认封面图，从当前美术资产里找一张弥音的图」。

## 选中：`web/public/art/miyin-portrait-320.webp`

| 判据 | 数 |
| --- | --- |
| 封面位是**宽幅**（卡片 16:9 / 后台 96×56 / 侧栏 20–56 方格），而 miyin/** 全是方图 | 宽幅下靠 `object-cover` 居中裁（`object-[50%_38%]`） |
| 裁到 16:9（256×144）后主体还在不在 | portrait 是**正面居中胸像** → 两只眼睛都在、脸在正中；smile-160 在 4:1 窄条上只剩一条闭眼弧线；welcome-400 在小方格里脸被切掉下半 |
| 铺在卡片上会不会糊成白纸 | 实测 256×144 的亮度/对比：portrait L=198 sd=35；welcome 228/26；wink 236/21；smile 210/28 —— 淡彩几张对比度不够，看着像「图没加载出来」 |
| 够不够大 | 320×320（14.2KB）。卡片封面位 256 逻辑像素、2x 屏 512 → 是最小够用那档，与 TopicCover 的 `MIN_COVER_WIDTH=320` 同一条尺子 |

出图（本地，`shots/` 被 .gitignore 排除）：`shots/fixcover2/00-contact-sheet.png`（四屏对照）、`e-chosen-art-portrait-320.png`（选中那张单拍）、`f-product-home-1440.png`（产品入口 /）。

## 步骤

- [x] ① 默认封面件落地 + 三个封面位换过去（首页卡片族 / 分区左栏 / 帖子页左栏 —— 后两者是同一个 BoardRail View）
  - 证据：先红 —— `npx vitest run src/ui/topic/default-cover.test.tsx` → `Failed to resolve import "./default-cover"`；
    `board-rail.test.tsx` → `AssertionError: expected '皇' to be ''`；`home.test.tsx` 两条 → `expected '/art/miyin/wink-520.webp' to be '/art/miyin-portrait-320.webp'`（帖子自己那张封面）与 `expected '/art/miyin-portrait-160.webp' to be '/art/miyin-portrait-320.webp'`（cover_width 太小的回落）。
    后绿 —— 四套 31 tests 全过（`default-cover 3 / board-rail 4 / home 12 / topic-view 12`），加 18-compose 共 47 passed。
    改的文件：`web/src/ui/topic/default-cover.tsx`(+test)、`14-home/topic-parts.tsx`、`03-navigation/board-rail.tsx`(+test)、`12-topic/topic-view.test.tsx`。
  - 下一步：后台列表缩略图无封面时（`15-admin/screens/boards.tsx` 的 32×32 行缩略图与 96×56 资料预览）换 `DefaultCover`；然后出图。
  - 阻塞：无（提交 `aeeeea6`）

- [x] ② 后台分区管理两处缩略图换 `DefaultCover` + 四屏出图 + 选中那张图单拍
  - 证据：先红 —— 把实现临时改回旧版（`ImageIcon` 虚框）跑 `boards.test.tsx` → `AssertionError: expected [] to have a length of 2 but got +0`；恢复后 4 tests 绿。
    出图（`CDP_SIZE=1440,900` / `390,844`，5202 静态服务 + CDP 9403–9408，按 PID 关）：`shots/fixcover2/` 的六张。
    看图结论：卡片上默认封面铺满 16:9、脸在正中、标题在下方卡体上（不压图）；左栏 20×20 与后台 32×32 都能认出是一张人脸；390 窄屏不裂不挤。
    另核：房间左栏前三行是**真封面的裂图**，因为 DevRoom 是静态服务、没有 `/img/<hash>` 读口 —— 实测 `/img/e70ef076…` → 404 而 `/art/miyin-portrait-320.webp` → 200，所以那一档不是默认封面该背的锅。
    全量：`npx vitest run` = 287 passed；`pnpm gate:ui`/`gate:controls`/`gate:urls` 三条全绿。（提交 `f0502ca`）
  - 下一步：`BoardCover` 的两个 prop（`slug`/`name`）已经没有使用者 —— 删掉并改三个调用点。
  - 阻塞：当时 `src/lib/api/admin.ts:409` 有人把 `in` 当参数名（`fetchAiPayload(in: {...})`），**在那个时刻的工作区里是解析错误** —— `pnpm typecheck` 7 条 TS 错、`pnpm lint` 1 条 error、`admin/ai.test.tsx` 与 `lib/api/admin.test.ts` 两个套件收集失败。全库这些错**只落在那一个文件**，与本包无关，按纪律不碰。（对方随后自己修好了，见 ③）

- [x] ③ 收尾：`BoardCover` 删掉用不到的 `slug`/`name`（首字那套的残留）+ 三个调用点改传参 + 测试调用点跟上
  - 证据：`npx vitest run src/devroom/pages/03-navigation src/devroom/pages/14-home src/devroom/pages/12-topic src/devroom/pages/18-compose src/devroom/pages/15-admin/screens/boards.test.tsx src/ui/topic` → `Test Files 9 passed`、`Tests 58 passed`。
    `pnpm typecheck | Select-String 'error TS'` → 本包文件 **0 条**（剩余 4 条全在别人正在改的 `15-admin/screens/users-footer.tsx` 与 `preview/admin-fixtures.ts`）；
    `pnpm lint` 输出里本包文件 0 条（含 warning）。提交 `944eb63` + `84f0d95`。
  - 下一步：无（本轮范围收口）。要动「用户主页壁纸的默认」（`routes/profile.tsx` 现回落 `starcraft/sc2-battle.webp`）需用户重新拍板 —— 那是横幅，不是封面。
  - 阻塞：无

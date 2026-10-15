# 进度 · FIX-COVER2（默认封面 = 美术资产里的一张弥音）

范围：`web/src/ui/**`（默认封面件）+ 各封面位的 View。派单：用户原话「应该有一张默认封面图，从当前美术资产里找一张弥音的图」。

## 选中：`web/public/art/miyin-portrait-320.webp`

| 判据 | 数 |
| --- | --- |
| 封面位是**宽幅**（卡片 16:9 / 后台 96×56 / 侧栏 20–56 方格），而 miyin/** 全是方图 | 宽幅下靠 `object-cover` 居中裁 |
| 裁到 16:9（256×144）后主体还在不在 | portrait 是**正面居中胸像** → 两只眼睛都在、脸在正中；smile-160 在 4:1 窄条上只剩一条闭眼弧线；welcome-400 在小方格里脸被切掉下半 |
| 铺在卡片上会不会糊成白纸 | 实测 256×144 的亮度/对比：portrait L=198 sd=35；welcome 228/26；wink 236/21；smile 210/28 —— 淡彩几张对比度不够，看着像「图没加载出来」 |
| 够不够大 | 320×320（14.2KB）。卡片封面位 256 逻辑像素、2x 屏 512 → 是最小够用那档，与 TopicCover 的 `MIN_COVER_WIDTH=320` 同一条尺子 |

## 步骤

- [x] 默认封面件落地 + 三处封面位换过去（首页卡片 / 分区左栏 / 帖子页左栏，都是同两个 View）
  - 证据：先红 —— `npx vitest run src/ui/topic/default-cover.test.tsx` → `Failed to resolve import "./default-cover"`；
    `board-rail.test.tsx` → `AssertionError: expected '皇' to be ''`；`home.test.tsx` 两条 → `expected '/art/miyin/wink-520.webp' to be '/art/miyin-portrait-320.webp'`（帖子自己那张封面）与 `expected '/art/miyin-portrait-160.webp' to be '/art/miyin-portrait-320.webp'`（cover_width 太小的回落）。
    后绿 —— 四套 31 tests 全过（`default-cover 3 / board-rail 4 / home 12 / topic-view 12`），加 18-compose 共 47 passed。
    改的文件：`web/src/ui/topic/default-cover.tsx`(+test)、`14-home/topic-parts.tsx`、`03-navigation/board-rail.tsx`(+test)、`12-topic/topic-view.test.tsx`。
  - 下一步：后台列表缩略图无封面时（`15-admin/screens/boards.tsx:171-173` 的 `ImageIcon` 虚框、`:276-278` 的 96×56 预览）换 `DefaultCover`；然后出图（首页卡片有/无封面、分区左栏、后台列表、390 窄屏、选中那张图单拍）。
  - 阻塞：无

# 进度 · MIG-ART（老站硬编码 → 可迁移资料）

- [x] 第1步：manifest + 导入命令 + media 的素材登记能力（含一处 Windows 平台的既有缺陷）
  - 做了什么：
    1. `完全重构/迁移素材/board-covers.json`（五个分区 → 图标文件，附**老站模板引用处**作为唯一真源）
       与 `SOURCES-starcraft.md`（Blizzard 素材出处/授权，镜像老站那份）；README 写清怎么用。
    2. `media.EnsureAsset`：内容寻址落盘 + 幂等登记 images 行（`ON CONFLICT DO NOTHING`，**不动引用计数**，
       owner_id = NULL）；`forum board-covers` 命令：落盘 → 登记 → 用 `media.IncRefTx` 挂 `boards.cover_hash`。
    3. 命令接线：`command.go` 的 Usage + `-manifest`/`-dry-run` 两个 flag（干跑不接库、不落盘）。
    4. **顺手修的既有缺陷**：`localstore/free_other.go` 原本返回 0，而 Put 的判据是 `free >= 0 && free < minFreeBytes`
       → 在量不出剩余空间的平台（Windows）上**任何带 minFreeBytes 的写入都报 media.disk_full**
       （app 传 512MiB ⇒ 图片上传与导入全 500）。改成 -1（量不出来 = 没有闸门），并补一条用例。
  - 证据：
    · `forum board-covers -dry-run`（本机，仓库根）输出五行 `would set <slug> → <sha256>`，exit 0；
      逐个与 `Get-FileHash` 对得上：announcement e70ef076…、vanilla-mod 3e585f10…、custom-campaign
      509bb743…、tool-player fd1a41d9…、tool-dev 70162fcf…。
    · `go test ./internal/app/ -run TestBoardCoversImportIsVisibleAndIdempotent -count=1`：
      第一遍 `mounted=5 unchanged=0 images_created=5`，第二遍 `mounted=0 unchanged=5 images_created=0`，
      断言 `GET /api/v1/boards` 五个 cover_hash == 各素材 sha256、每个 refcount == 1、盘上文件数不增 —— PASS。
    · `go test ./internal/media/ -count=1` ok；`go test ./internal/platform/image/localstore/ -count=1` ok；
      `gofmt -l internal/app internal/media internal/platform/image/localstore` 空、`go vet` 这两包 0。
  - 下一步：本地起真库跑一次真命令（migrate + seed → board-covers → 再跑一次）并把 `/api/v1/boards` 的
    真实响应贴进 `完全重构/数据迁移审计.md`；然后出图（DevRoom 03-navigation 与产品首页，左侧栏要看得见图标）；
    最后落「老站硬编码对照表」（PostSection 五 slug+中文 label+发帖权限 / ResourceProvider 八家网盘 /
    site_texts 13 键 / 默认头像池 / 公告区发帖门槛）。
  - 阻塞：无。
- [x] 第2步：真库实跑（两次）+ 真接口取证 + 两张出图（顺手修好出图工具的一处「0 字节假成功」）
  - 做了什么：
    1. **真进程 + 真库**跑了完整链路：`forum migrate`（version=51）→ `forum seed`（boards=5 users=11
       topics=25 posts=75）→ `forum board-covers` **两遍** → `forum run` → 真打 `GET /api/v1/boards`。
       数据库是本机嵌入式 PostgreSQL 18.3（DSN `postgres://forum:forum@127.0.0.1:24817/forum_dev`）。
    2. 出图：`shots/mig-art/03-navigation-room.png`（DevRoom `03-navigation` 的分区侧栏）与
       `shots/mig-art/product-home.png`（产品首页 `web/product.html?route=/`）—— 左边栏图**真的画出来了**。
    3. 顺手修的既有缺陷：`web/scripts/cdp-shot.ts` 的 `shot()` 读 `result.value`，而 CDP 把 PNG 放在
       `result.data` → **每张图都是 0 字节，脚本照样打印 OK**。已改成读 `.data` 并在为空时抛错。
    4. 让桩与真值对齐：`product-fixture.ts` 的 BOARDS 原来写 `cover: null`（**这个字段名在 BoardDTO 里不存在**，
       forum/dto.go:43 是 `cover_hash`）→ 产品预览左栏永远只有首字占位；`03-navigation/index.tsx` 的
       DEMO_BOARDS 原来借 `assetUrl(...)` 当 URL。两处都换成**导入命令写进库的那五个真 sha256**。
  - 证据：
    · 第一遍 `board-covers: ok, mounted=5 unchanged=0 images_created=5`；第二遍
      `mounted=0 unchanged=5 images_created=0`（exit 0 / 0）。
    · `GET http://127.0.0.1:19399/api/v1/boards`（真服务）五个分区：
      announcement e70ef076…、vanilla-mod 3e585f10…、custom-campaign 509bb743…、tool-player fd1a41d9…、
      tool-dev 70162fcf…（与文件 sha256 逐个相同）；`GET /img/<hash>` → `200 image/webp`，
      字节 sha256 == 该 hash（取了两张核过）。
    · 出图：两页 `broken=0`，`/img/*` 共转真后端 11 次（预览静态服务本来没有这条读口）。
      图上读得到：DevRoom 页 `BoardRail` 四行图标 + 皇帝区首字占位；产品首页左栏五行图标。
  - 下一步：落「老站硬编码 vs 新站」对照表（PostSection 五 slug+中文 label+发帖权限 / ResourceProvider 八家 /
    site_texts 13 键 / 默认头像池 / 公告区发帖门槛），把已迁/待迁/不迁与理由写进 `完全重构/数据迁移审计.md`。
  - 阻塞：无。

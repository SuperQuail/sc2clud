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

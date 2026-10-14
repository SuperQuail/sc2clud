# 迁移素材（MIG-ART）

老站硬编码的东西 → 可迁移的资料。这里的东西**都被代码读**，不是只写给人看的文档。

## board-covers.json

新站五个分区（`boards.slug`）的侧栏图标。老站把分区写死在 `site/crates/sc2clud-core/src/resource.rs` 的
`PostSection` 枚举里，图标在模板里按 `nav-{{ section.value }}.webp` 取
（`site/crates/sc2clud-web/templates/index.html:38` —— **这就是映射的唯一真源**，不是照 slug 猜文件名）。

| 字段 | 含义 |
|---|---|
| `slug` | 新站 `boards.slug`（老站的 key 下划线换连字符，见《数据迁移审计》§1 `sections`） |
| `file` | 图标文件，**相对 `web.dist_dir`（前端产物根）**——dev 是 `web/dist`，线上是 `<实例>/current/web/dist` |
| `legacy_section` | 老站 `sections.key` / `PostSection::as_str()` |
| `source` | 老站模板的引用处（文件:行） |

图标字节与老站 `site/crates/sc2clud-web/static/art/starcraft/nav-*.webp` **逐字节相同**（Lead 已核 SHA256），
所以迁移只差「把图写进图片存储 + 登记 images + 挂到 boards.cover_hash」。

## 怎么用（生产与 dev 同一条命令）

```bash
# 先看要写什么（不碰库、不落盘）
forum board-covers -manifest /path/to/完全重构/迁移素材/board-covers.json -dry-run

# 真写：内容寻址落盘 → upsert images 行 → 设 boards.cover_hash（引用计数走 media.IncRefTx）
forum board-covers -manifest /path/to/完全重构/迁移素材/board-covers.json
```

幂等：跑第二遍输出 `unchanged=5`，refcount 不长、`updated_at` 不动、不重复落盘（内容寻址按 hash 去重）。

## 授权

图标是 Blizzard 的星际争霸 II 游戏美术，取自公开图标镜像仓库（**只取图，不取代码**），
版权归 Blizzard Entertainment。逐张的原始地址与说明见 [SOURCES-starcraft.md](SOURCES-starcraft.md)。
SC2clud 是非官方玩家社区。

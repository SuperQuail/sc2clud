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

## ai-config.json

老站 **AI 审核配置的值**（第三轮拍板 §1c：「E3『AI 配置新站没有』这句已过时，把值也纳入迁移资料」）。
真源是**老站 SQLite 的 site_texts 表**，不是代码里的字面量：`site/migrations/0029_ai_review.sql`
给的只是默认值（`api.openai.com/v1` / `gpt-4o-mini`），线上被超管在后台改过就以库为准 ——
本文件抄的是备份里的**库值**：`backups/old-prod-2026-10-12/sc2clud.sqlite3`。

| 字段 | 老站真源 | 逐字？ |
|---|---|---|
| `enabled=false` | `site_texts.ai_enabled='0'` | 逐字（且与 `site_settings.ai.review.enabled`（默认 off）是「且」，两处都关着才是老站的「零外呼」） |
| `base_url=https://api.deepseek.com` | `site_texts.ai_endpoint` | 逐字（0029 的默认是 openai，线上已改） |
| `model=deepseek-flash` | `site_texts.ai_model` | 逐字（0029 的默认是 gpt-4o-mini，线上已改） |
| `prompt` / `prompt_report` | `site_texts.ai_prompt_new_post` / `ai_prompt_report` | **逐字**（老站那两段中文原文，一字不改） |
| `temperature=0` | 老站请求体硬编码 `temperature: 0`（ai.rs） | 逐字 |
| `thinking=false` | `site_texts.ai_reasoning_effort=''`（不传 → 服务端默认 high = 思考开） | **不是等价**：新站按 d7 默认走「快」路径（`tool_choice: required`），要回老站行为在后台打开 thinking |
| `strict_mode=false` | 老站没这项 | 新站默认（strict 要求 base_url 带 `/beta`） |
| `timeout_ms=30000` / `max_output_tokens=2048` | 老站 HTTP 60s；正式审核不传 max_tokens | **不是逐字**：新站外呼在队列 worker 里，30s / 2048 是 d7 的新默认（DDL 允许 1000–60000 / 64–4096） |

**没有迁的**（`not_migrated` 一栏逐条写了为什么）：

- **API Key**：老站 `ai_secrets` 那行密文是用**老站自己的主密钥**加的（sc2clud-core 的 Crypter），
  备份里没有任何主密钥材料（`secrets/` 不入库），所以它在新站**解不开也搬不过去** ——
  只能在目标实例上重配一次：后台 `POST /api/v1/admin/ai/config/secret`，或 env `FORUM_AI__KEY`。
  证据：`python -c "import sqlite3;print(sqlite3.connect('file:backups/old-prod-2026-10-12/sc2clud.sqlite3?mode=ro',uri=True).execute('select count(*) from ai_secrets').fetchone())"`
  → `(1,)`，两列都是密文；仓库里搜不到老站主密钥（它的真源在 `secrets/env/production.env`，不进版本库）。
- `ai_review_posts='1'` / `ai_review_on_report='1'`：不是配置值，是**结构性开关**
  （新站由 `review_policy` 决定 `review_state`、AI 只当判定来源 —— d7 §1，这条路径恒开）。
- `ai_review_comments='0'`：新站评论=楼层，走同一套帖子审核，功能不存在。
- `ai_reasoning_effort`：老站这一格自己就是空的；新站没有这一列（由 `thinking` 布尔表达）。

## 怎么用（生产与 dev 同一条命令）

```bash
# 先看要写什么（不接库）
forum ai-config -manifest /path/to/完全重构/迁移素材/ai-config.json -dry-run

# 真写：一条 UPDATE 只改与目标不一致的那几格（幂等，跑第二遍 changed=0）
forum ai-config -manifest /path/to/完全重构/迁移素材/ai-config.json
```

密钥不在 manifest 里，配完再跑 `POST /api/v1/admin/ai/test` 看连通（后台「AI 审核」屏那颗按钮）。

## 授权

图标是 Blizzard 的星际争霸 II 游戏美术，取自公开图标镜像仓库（**只取图，不取代码**），
版权归 Blizzard Entertainment。逐张的原始地址与说明见 [SOURCES-starcraft.md](SOURCES-starcraft.md)。
SC2clud 是非官方玩家社区。

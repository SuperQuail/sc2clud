# D5 交接单（媒体 / 下载 / 搜索 / 验证码 / 默认头像）

> 配套设计：[`d5-content.md`](d5-content.md)。**实现前请先读那一份**，本文只回答三件事：本域对外给什么、本域要别人给什么、哪些还没定。
> 本轮不写代码。实现顺序建议：`platform/image` → `platform/search` → `platform/captcha` → `media` → `release` → `forum` 的 search:index 处理函数（跨域）。

---

## 1. 本域对外暴露的 Go 接口

### 1.1 `internal/platform/image`（Store）

    package image

    var (
        ErrNotFound = errors.New("image: not found")
        ErrTooLarge = errors.New("image: too large")
        ErrBadType  = errors.New("image: bad type")
        ErrDiskFull = errors.New("image: disk full")
    )

    type Hash string   // 64 位小写 hex

    type Store interface {
        Put(ctx context.Context, r io.Reader, maxBytes int64) (Hash, int64, error)
        Open(ctx context.Context, h Hash) (io.ReadCloser, error)
        Stat(ctx context.Context, h Hash) (int64, error)
        Delete(ctx context.Context, h Hash) error
        Walk(ctx context.Context, fn func(Hash) error) error
    }

    // internal/platform/image/localstore
    func New(root string, minFreeBytes int64) (*Store, error)

    // internal/platform/image/imgsize
    func Sniff(head []byte) (mime string, ok bool)
    func Size(mime string, head []byte, tail func(off int64, n int) ([]byte, error), size int64) (w, h int, err error)

- 只做四种格式（PNG/JPEG/GIF/WebP），**SVG 必拒**；判字节不判 Content-Type/扩展名。
- `Put` 是唯一写入口：边读边算 sha256、超 `maxBytes` 立刻返回 `ErrTooLarge`（半成品会删掉）、同盘 rename、**fsync 文件与父目录**。
- 平台差异：`syscall.Statfs` 放 `free_unix.go`（`//go:build unix`），`free_other.go` 返回 0 = 不判（Windows 开发机自动关闸门）。

### 1.2 `internal/platform/search`（分词器 + 搜索器 + 索引器）

    package search

    const MaxTokens = 20000
    // 词素 = 单字 + bigram：Tokenize("大吉大利") == "大 大吉 吉 吉大 利 大利"
    func Tokenize(s string) string      // 索引与查询**唯一**的分词入口

    type Hit struct { TopicID int64; PublicID string; Title string; Rank float32 }
    type Tier string                    // "exact"（档 1，AND）| "loose"（档 2，单字 OR）
    type Query struct {
        Tokens     string               // = search.Tokenize(q)
        BoardID    *int64
        Tier       Tier                 // 空 = 由 Searcher 自己决定（先 exact）
        CursorRank *float32
        CursorID   *int64
        Limit      int
    }
    type Page struct { Hits []Hit; Tier Tier; NextCursorRank *float32; NextCursorID *int64 }
    type TopicDoc struct { TopicID int64; Title, BodyText, Tokens string }

    type Searcher interface { SearchTopics(ctx context.Context, q Query) (Page, error) }
    type Indexer interface {
        UpsertTopic(ctx context.Context, doc TopicDoc) error
        DeleteTopic(ctx context.Context, topicID int64) error
    }

    // internal/platform/search/pgsql （原生 SQL 只在这个包与手写迁移里）
    func New(db *ent.Client) *Searcher

- **词素 = 单字 + bigram**：单字查询也走同一个 GIN（review R-D5-1）。**没有** `FallbackSearcher`、**没有** `tokens ILIKE` 兜底。
- 两档查询在 `Searcher` 内部：档 1（`plainto_tsquery`，AND）先跑，**只有首页 0 行**才降级到档 2（`to_tsquery`，单字 OR），响应带 `tier`；翻页把 `tier` 原样带回（review R-D5-2）。
- 业务侧**不得**自己拼 `to_tsquery`/`tsv @@`；调 `Searcher` 即可。档 2 的 OR 串由本包用**单字词素**拼，逐词素断言只含内容字符，并且 `$1` 仍是参数占位符。

### 1.3 `internal/platform/captcha`（Verifier）

    package captcha

    var (ErrNotFound = errors.New("captcha: not found"); ErrWrong = errors.New("captcha: wrong"))

    type Verifier interface {
        Issue(ctx context.Context) (id string, png []byte, err error)
        Verify(ctx context.Context, id, answer string) error
    }

    // internal/platform/captcha/imagecaptcha
    func New(cache kv.Cache, clock clock.Clock) *Verifier

- 常量（不配置）：答案 TTL 5 分钟、失败阈值 5 次、失败窗口 10 分钟。
- Redis 故障时 `Issue` 报错、`Verify` 返回 `ErrNotFound`（**不放行**）。
- **取消消费**：`Verify` 无论对错先 `Del`。

### 1.4 `internal/media`（Service，业务域）

    func NewService(cfg config.Image, db, dbRead *ent.Client, store image.Store,
                    users UserAvatar, clock clock.Clock) *Service

    type Media struct { Hash string; Size int64; Mime string; Width, Height int; Visibility string; OwnerID *int64 }

    func (s *Service) UploadAvatar(ctx, actor *authz.Actor, in UploadAvatarInput) (*AvatarResult, error)
    func (s *Service) ClearAvatar(ctx, actor *authz.Actor) error
    func (s *Service) AttachTopicImage(ctx, actor *authz.Actor, in AttachTopicImageInput) (*AttachedImage, error)
    func (s *Service) DetachTopicImage(ctx, actor *authz.Actor, in DetachTopicImageInput) error
    func (s *Service) AddPaymentChannel(ctx, actor *authz.Actor, in AddPaymentChannelInput) (*PaymentChannel, error)
    func (s *Service) ListPaymentChannels(ctx, actor *authz.Actor, userPublicID string) ([]PaymentChannel, error)
    func (s *Service) DeletePaymentChannel(ctx, actor *authz.Actor, channelPublicID string) error
    func (s *Service) FetchImage(ctx, actor *authz.Actor, hash string) (*ImageResponse, error)
    func (s *Service) IncRefTx(ctx, tx *ent.Tx, h image.Hash) error
    func (s *Service) DecRefTx(ctx, tx *ent.Tx, h image.Hash) error
    func (s *Service) GCImages(ctx, payload []byte) error            // image:gc 任务

    type UserAvatar interface {   // deps.go，由 user 域实现
        SetAvatarTx(ctx, tx *ent.Tx, userID int64, h *image.Hash) (old *image.Hash, err error)
        Avatars(ctx, userIDs []int64) (map[int64]string, error)
    }

**给别的域的两个方法就是全部**：`IncRefTx` / `DecRefTx`。任何在自表里引用 `images.hash` 的域（boards.cover_hash、users.avatar_hash/avatar_small_hash）都必须在自己事务里调它们，±1 不许自己写 SQL（写了就绕过了 §2.2 的时机表）。

### 1.5 `internal/release`（Service）

    func NewService(db, dbRead *ent.Client, counter *counter.Buffer, clock clock.Clock, log *slog.Logger) *Service

    func (s *Service) Latest(ctx, channel string) (*ReleaseDetail, error)
    func (s *Service) ListReleases(ctx, in ListReleasesInput) (*ReleasePage, error)
    func (s *Service) ResolveAsset(ctx, assetPublicID string) (url string, err error)   // 302；计数在这里加
    func (s *Service) UpsertRelease(ctx, actor *authz.Actor, in UpsertReleaseInput) (*ReleaseDetail, error)
    func (s *Service) SetReleaseStatus(ctx, actor *authz.Actor, in SetReleaseStatusInput) error
    func (s *Service) UpsertAsset(ctx, actor *authz.Actor, in UpsertAssetInput) (*Asset, error)
    func (s *Service) DeleteAsset(ctx, actor *authz.Actor, assetPublicID string) error
    func (s *Service) FlushDownloads(ctx) error

---

## 2. 路由注册（谁挂哪条）

| 方法 | 路径 | 中间件 | handler 归属 | 备注 |
|---|---|---|---|---|
| POST | `/api/v1/me/avatar` | `RequireLogin` | media | 体上限 69632 |
| DELETE | `/api/v1/me/avatar` | `RequireLogin` | media | |
| POST | `/api/v1/topics/:id/images` | `RequireLogin`, `Perm(PermTopicCreate)` | media | 体上限 2101248；`:id` 是 topic public_id |
| DELETE | `/api/v1/topics/:id/images/:hash` | `RequireLogin` | media | `:hash` 是 64 位 hex |
| POST | `/api/v1/me/payment-channels` | `RequireLogin` | media | 体上限 528384 |
| GET | `/api/v1/me/payment-channels` | `RequireLogin` | media | |
| DELETE | `/api/v1/me/payment-channels/:id` | `RequireLogin` | media | |
| GET | `/img/:hash` | 无 | media | **不在 /api/v1 下**；visibility 判定在 service |
| GET | `/api/v1/captcha` | 无（限流 `auth:captcha:ip:<ip>`） | auth（能力来自 captcha） | `Cache-Control: no-store` |
| GET | `/api/v1/search` | 无 | forum（能力来自 search） | `?q=&type=topics\|users&board=&limit=&cursor=` |
| GET | `/api/v1/launcher/latest` | 无 | release | |
| GET | `/api/v1/launcher/releases` | 无 | release | `?channel=&limit=&cursor=` |
| GET | `/api/v1/launcher/assets/:id/go` | 无 | release | `:id` = asset public_id；302 |
| POST/PATCH/DELETE | `/api/v1/admin/launcher/releases` · `/assets` | `RequireLogin`, `Perm(PermSiteSetting)` | release（挂管理域路由组） | 21.2 没有更细的权限点，**不新增** |

**请求体上限必须按路由设**（`http.MaxBytesReader`），不许全局一刀切 1MB。

---

## 3. 我依赖别人的什么

| 依赖 | 谁提供 | 形状（我这边定义的接口） | 用途 | 触发时点 |
|---|---|---|---|---|
| 用户头像读写 | D1 user 域 | `media.UserAvatar`（§1.4） | 头像替换、列表页头像 | `POST/DELETE /me/avatar`、列表渲染 |
| 当前身份 | D1 auth/authz | `*authz.Actor`（显式入参） | 全部写操作与可见性判定 | 每请求 |
| 权限点常量 | D1 authz | `PermTopicCreate`、`PermRewardVerify`、`PermSiteSetting`、`PermTopicDeleteAny` | 路由声明 + service 兜底 | — |
| 事务入口 | platform/db | `WithTx(ctx, client, fn)` | 计数与引用行的原子性 | — |
| 队列 | platform/queue | `EnqueueTx`、`Handle`、`TypeImageGC`、`TypeSearchIndex` | GC 与索引任务 | 主题写操作、cron |
| KV | platform/kv | `Cache.Get/Set/Del` | 验证码答案、失败计数 | — |
| 计数器 | platform/counter | `Add(key string, n int64)` + 每 15 秒回调 | 下载计数 | 每次 302 |
| 时钟 | platform/clock | `Now()` | 全部时间 | — |
| 配置 | D1 config | `config.Image{Root,ServeLocally,AvatarMax,PostMax,PaymentMax,MinFreeBytes}`、`config.Captcha{Mode}` | 上限与开关 | 启动 |
| 外链校验 | D3 forum（topic_sources 的同一套） | `CheckOutboundURL(raw string) error` | release asset 的 url、资源帖转链 | 管理端录入 |
| 纯文本抽取 | **D3 forum 待定**（未决 9） | `PlainText(html string) string` | search:index 的 `body_text` | 索引任务 |
| 主题列表查询 | D3 forum | 按 `[]Hit` 的 id 批量补作者/计数 | 搜索结果补全 | 每次搜索 |
| `GET /api/v1/search` 的 handler | **D3 forum** | 调 `search.Searcher`；把 `Query.Tier` 与响应里的 `tier` 在翻页时原样传递 | 两档查询（review R-D5-2） | 每次搜索 |
| 主题写入侧的入队 | **D3 forum 必须做** | 主题创建/改标题/改 1 楼/改可见性/改审核态/删除时 `EnqueueTx(TypeSearchIndex, unique_key="topic:<id>")` | 索引不漂移 | 见设计 §6.5 |
| 外键索引 | D1 账号域 | `users.avatar_hash`、`avatar_small_hash`、`default_avatar_hash` 三个索引 | 解引用与回收时不全表扫 | 迁移 |
| `boards.cover_hash` 的 ±1 | D2 版块域 | 调 `media.IncRefTx/DecRefTx` | 封面图回收 | 改封面 |
| nginx | 运维 | `location /_img/ { internal; alias <root>; types { } default_type application/octet-stream; }` | 生产直出 | 部署 |

**我提供给别人**：`image.Store`（无业务耦合）、`search.Tokenize`/`Searcher`/`Indexer`、`captcha.Verifier`、`media.IncRefTx/DecRefTx`、`media.FetchImage`（`/img/:hash` 的落点唯一）。

---

## 4. 数据库归属：本域要写的迁移

| 迁移文件 | 内容 | ent schema 能不能生成 |
|---|---|---|
| `0002_media.sql` | `images` / `default_avatars` / `topic_images` / `payment_channels` 建表；`users` 加 `default_avatar_hash` + 索引 | 表与普通索引能；**CHECK、`refcount=0` 部分索引、hash 正则 CHECK、`(topic_id,sort)` 唯一索引、`users` 的 ALTER 必须手写** |
| `0003_release.sql` | `releases` / `release_assets` 建表 + `autovacuum_*` 存储参数 | 表与索引能；**CHECK（url 正则、sha256 正则、channel/status 值域）、存储参数、`ALTER TABLE ... SET` 必须手写** |
| `0004_search.sql` | `topic_search` + `tsv` 生成列 + 两个 GIN（其中一个要 `gin_trgm_ops`）+ 存储参数 | 表能；**生成列、GIN 的 opclass、`pg_trgm` 依赖、存储参数必须手写**（生成列与表达式索引 ent 表达不了） |
| `0001_extensions.sql`（已由 S1 规划） | `CREATE EXTENSION IF NOT EXISTS pg_trgm;` | 手写（必须是第一个迁移） |

ent 侧的落地方式（schema 文件归 S1 的 `internal/ent/schema/`，本域只给要求）：

- `internal/ent/schema/image.go`：字段 `hash`(String, 手动 setter；主键)、`size`(Int64)、`mime`(String)、`width`/`height`(Int, Default(0) + CHECK 在手写迁移)、`refcount`(Int, Default(1))、`visibility`(String, Default("public"))、`owner_id`(Int64, Optional, Nillable)，`Edges` 到 users；`Indexes()` 里写 `entgo.io/ent/dialect/entsql.IndexWhere("refcount = 0")` 的部分索引（**若该注解在本版本不可用，就在手写迁移里建，schema 里不写**——不要为了它改 ent 版本）。
- `internal/ent/schema/topic_image.go`：复合主键 `(topic_id, image_hash)`（`field.Int64("topic_id")` + `field.String("image_hash")` + `Indexes()` 的唯一复合）；`sort` 的 `CHECK BETWEEN 0 AND 8` 与 `uq_topic_images_sort` 在手写迁移。
- `topic_search` **不进 ent 读写路径的常规使用**：它的写入/查询都在 `platform/search/pgsql` 的原生 SQL 里（硬规则 8 的例外清单明确包含这个包）。schema 里仍建实体（表清单与迁移需要），但业务代码不通过 ent 读写它 —— 这一点要 Lead 确认（另一个选择是让它彻底只存在于手写迁移里；代价是 S1 的「空库跑迁移 vs ent snapshot」一致性检查会报出这张表）。

---

## 5. 未决问题（与设计 §12.3 同一份，这里列**需要谁拍**）

| # | 问题 | 需要谁 | 不定的后果 |
|---|---|---|---|
| 1 | 收款码对访客不可见（private + 占位图）是否接受？还是要加「打赏弹窗里的一次性直出链接」 | 产品 | 打赏弹窗对游客永远显示裂图/占位图 |
| 2 | 池子为空时的内置兜底头像：静态 URL 还是启动时自举进 `images` | Lead（涉及「启动是否可以写库」） | 头像 URL 出现第三种形状 |
| 3 | `releases.version` 全局唯一 vs `(channel, version)` 唯一 | Lead | 以后想发同名 stable/beta 要改迁移 |
| 4 | 硬删用户导致的 refcount 泄漏：接受对账修，还是加触发器 | Lead（与「不建触发器」的全局约定冲突） | 少量图片永远不回收 |
| 5 | 是否保留 `pg_trgm`（单字搜索到底要不要支持） | 产品 + Lead | 多一个扩展与一个 GIN 的写成本 |
| 6 | 默认头像池变更后的生效方式（重启 / 写后重载 / 每次查库） | Lead | 管理员改完池子以为立刻生效 |
| 7 | `image.serve_locally` 的默认值与 `forum check` 的警告 | Lead | 本地开发起服务就没有图 |
| 8 | 上传侧要不要字节限速/并发闸门（老站有） | Lead（内存预算） | 并发上传的瞬时内存峰值 |
| 9 | `PlainText(html)` 归 D3 forum 还是 D5 platform/search | Lead | 第二份 HTML→文本实现（摘要与索引各一份） |
| 10 | `topic_search` 要不要进 ent schema 实体 | Lead（影响 S1 的一致性检查） | S1 的自检可能因为这张「只存在于手写迁移的表」变红 |

| 11 | 档 2（OR 兜底）只在档 1 **首页** 0 行时降级（不是每页都判）；档 2 用 `ts_rank` 排序 | Lead + 产品（设计 §12.3 未决 11/12） | 「正好一页精确结果」时第 2 页不会降级；档 2 的排序口径 |
| 12 | `forum check` 的搜索闸门阈值（命中 >1 万行告警；CI 高频词 <200ms 硬断言） | Lead（review R-D5-3） | 超阈值时是改设计（物化分数列）还是改闸门 |
（默认头像按 id 取模 vs 分一次固定、`topic_images` 的端点维度、gse vs bigram），回写清单见设计 §12.2。

---

## 6. 实现顺序与验收命令（交回时贴输出）

    # 1) 单元（不碰库）
    cd forum && gofmt -l . && go vet ./... && go test ./internal/platform/image/... ./internal/platform/search/...
    # 2) 集成（embedded-postgres，真迁移）
    go test ./internal/media/... ./internal/release/...
    # 3) EXPLAIN 门禁（设计 §11.1 第 11–16 条）
    go test ./internal/platform/search/pgsql -run TestExplain
    # 4) M8 的四档验收（设计 §6.9：单字 / 两字 / 长词整串 / 长词丢字 + 三条可见性反例）
    go test ./internal/platform/search -run TestTokenize -v
    go test ./internal/platform/search/pgsql -run 'TestTwoTier|TestSingleCharUsesGin'
    # 5) 搜索闸门（设计 §11.1 第 15/16 条：命中行数告警 + 高频词 <200ms）
    go test ./internal/platform/search/pgsql -run TestHighFreqLatency
    # 6) 自检（设计 §11.4，进 forum check）
    ./forum check

**Mid-work 需要 D3 配合的两处**：① 主题写操作的 `EnqueueTx(TypeSearchIndex)`（设计 §6.7 的表）；② `PlainText`（未决 9）。这两处在 D3 的写路径里，**本域不碰 forum 的代码**。

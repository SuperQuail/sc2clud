# D3 交接单（论坛核心：分区 / 主题 / 回复 / 投票 / 收藏 / 拉黑 / 禁言 / 下载源 / Issue）

> 配套设计：[`d3-forum.md`](d3-forum.md)。**实现前先读那一份**，本文只回答三件事：本域对外给什么、本域要别人给什么、哪些还没定。
> 本轮不写代码。建议实现顺序：迁移 `0005_forum.sql` → `repo.go`（§3 的五条列表 + §5 的投票）→ `acl.go` → `handler.go` → Issue 与下载源。

---

## 1. 本域对外暴露的 Go 接口

### 1.1 `internal/forum`（Service）

```go
func NewService(db *ent.Client, clk clock.Clock, counters counter.Buffer, q queue.Queue, deps Deps) *Service

// 读（游客可调，actor 传 nil）
func (s *Service) ListBoards(ctx context.Context, actor *authz.Actor) ([]BoardDTO, error)
func (s *Service) BoardBySlug(ctx context.Context, slug string) (*BoardDTO, error)
func (s *Service) ListTopics(ctx context.Context, actor *authz.Actor, in ListTopicsInput) (*TopicPage, error)
func (s *Service) ListPinned(ctx context.Context, boardID int64) ([]TopicBriefDTO, error)
func (s *Service) TopicDetail(ctx context.Context, actor *authz.Actor, publicID string) (*TopicDetailDTO, error)
func (s *Service) ListPosts(ctx context.Context, actor *authz.Actor, in ListPostsInput) (*PostPage, error)
func (s *Service) ListReplies(ctx context.Context, actor *authz.Actor, postPublicID string) ([]PostDTO, error)
func (s *Service) ListUserTopics(ctx context.Context, actor *authz.Actor, handle string, in PageInput) (*TopicPage, error)
func (s *Service) ListBookmarks(ctx context.Context, actor *authz.Actor, in PageInput) (*TopicPage, error)
func (s *Service) ListSources(ctx context.Context, topicPublicID string) ([]SourceDTO, error)
func (s *Service) GoSource(ctx context.Context, topicPublicID, sourcePublicID string) (string, error)

// 写（actor 必须是登录者；nil → 401）
func (s *Service) CreateTopic(ctx context.Context, actor *authz.Actor, in CreateTopicInput) (*TopicDetailDTO, error)
func (s *Service) UpdateTopic(ctx context.Context, actor *authz.Actor, publicID string, in UpdateTopicInput) error
func (s *Service) DeleteTopic(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) LockTopic(ctx context.Context, actor *authz.Actor, publicID string, locked bool) error
func (s *Service) SetPinned(ctx context.Context, actor *authz.Actor, publicID string, pin, featured bool) error
func (s *Service) CreatePost(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreatePostInput) (*PostDTO, error)
func (s *Service) UpdatePost(ctx context.Context, actor *authz.Actor, publicID, contentMD string) error
func (s *Service) DeletePost(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) Vote(ctx context.Context, actor *authz.Actor, t VoteTarget, publicID string, value int) (*VoteResultDTO, error)
func (s *Service) Unvote(ctx context.Context, actor *authz.Actor, t VoteTarget, publicID string) (*VoteResultDTO, error)
func (s *Service) Bookmark(ctx context.Context, actor *authz.Actor, topicPublicID string, on bool) error
func (s *Service) BlockUser(ctx context.Context, actor *authz.Actor, handle string, on bool) error
func (s *Service) SaveSource(ctx context.Context, actor *authz.Actor, topicPublicID string, in SourceInput) (*SourceDTO, error)
func (s *Service) DeleteSource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error
func (s *Service) VerifySource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error

// Issue
func (s *Service) ListIssues(ctx context.Context, actor *authz.Actor, in ListIssuesInput) (*IssuePage, error)
func (s *Service) IssueDetail(ctx context.Context, actor *authz.Actor, publicID string) (*IssueDetailDTO, error)
func (s *Service) CreateIssue(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreateIssueInput) (*IssueDTO, error)
func (s *Service) UpdateIssue(ctx context.Context, actor *authz.Actor, publicID string, in UpdateIssueInput) error
func (s *Service) ListIssueComments(ctx context.Context, actor *authz.Actor, issuePublicID string, in PageInput) (*IssueCommentPage, error)
func (s *Service) CreateIssueComment(ctx context.Context, actor *authz.Actor, issuePublicID string, in CreateCommentInput) (*IssueCommentDTO, error)
func (s *Service) ListIssueCommentReplies(ctx context.Context, actor *authz.Actor, commentPublicID string) ([]IssueCommentDTO, error)

// 给别的域用（接口在使用方定义，本域只是碰巧实现了它）
func (s *Service) BlockedBetween(ctx context.Context, a, b int64) (aBlockedB, bBlockedA bool, err error) // D4 message 用
func (s *Service) ResolveTargetOwner(ctx context.Context, targetType string, targetID int64) (int64, error) // D6 reports 用
```

### 1.2 关键 DTO（响应形状，字段名即 JSON 名）

```go
type TopicCardDTO struct {
    ID, Kind, Title, Excerpt            string
    Board                               struct{ Slug, Name string }
    Author                              UserBrief
    ReplyCount, LikeCount               int
    ViewCount                           int64
    LastReplyAt, CreatedAt              time.Time
    Pinned, Featured, Locked            bool
    CoverHash                           string  // "" = 无封面；前端拼 /img/<hash>
    CoverWidth, CoverHeight             int     // 来自 images.width/height（D5）
}
type PostDTO struct {
    ID, ParentID, ContentHTML           string
    Floor                               int
    Author                              UserBrief
    LikeCount, DislikeCount             int
    MyVote                              int     // -1 | 0 | 1（游客恒 0）
    ReplyTotal                          int     // 楼中楼条数
    PreviewIDs                          []string// 前 3 条楼中楼的 public_id，顺序即展示顺序
    CreatedAt, UpdatedAt                time.Time
}
type SourceDTO struct {
    ID, GoPath, Label, URL              string  // GoPath = /api/v1/topics/<tid>/sources/<sid>/go
    Provider                            string  // 开放 key（baidu/quark/github/website/…），图标由前端查表
    ExtractionCode                      *string
    Size                                string  // "2.4 GB"（DB 列名 size_text，响应名 size）
    Upkeep                              string  // active | archived
    VerifiedAt                          *time.Time
}
type IssueDTO struct {
    ID, Title, Kind, Status             string
    Number                              int
    Author                              UserBrief
    Assignee                            *UserBrief
    Tags                                []string
    CommentCount                        int
    CreatedAt, UpdatedAt                time.Time
}
```

**分页响应**：`{ "data": [...], "next_cursor": "…" | null }`（拍板 §5.1）。`next_cursor` 只在 `len(rows) == limit` 时给。

### 1.3 `VoteTarget` 与 `PageInput`

```go
type VoteTarget string
const (
    VotePost         VoteTarget = "post"          // PUT|DELETE /api/v1/posts/{id}/vote
    VoteIssueComment VoteTarget = "issue_comment" // PUT|DELETE /api/v1/issue-comments/{id}/vote
    VoteTopic        VoteTarget = "topic"         // PUT|DELETE /api/v1/topics/{id}/like（只接受 value=1）
)

type PageInput      struct { Cursor string; Limit int }
type ListPostsInput struct { TopicPublicID, Cursor string; Limit int }
```

`VoteTarget` 是字符串常量集而不是三个方法：三个方法会把「票数加在哪个列上」这件事写三遍。

---

## 2. 路由注册（谁挂哪条）

| 方法 | 路径 | 中间件 | handler 归属 | 备注 |
|---|---|---|---|---|
| GET | `/api/v1/boards` | 无 | forum | 含 cover 与现算的三个统计 |
| GET | `/api/v1/boards/:slug` | 无 | forum | 同上 |
| GET | `/api/v1/topics` | 无 | forum | `?board=&kind=&sort=latest|new&limit=&cursor=` |
| POST | `/api/v1/topics` | `RequireLogin` + `topic.create` | forum | 体上限 256KB；`client_token?` |
| GET | `/api/v1/topics/:id` | 无 | forum | 含 `issue_open_count` / `viewer` / `sources[]` / `images[]` |
| PATCH | `/api/v1/topics/:id` | `RequireLogin` + `topic.edit.own` | forum | 归属与 `topic.move` 在 service |
| DELETE | `/api/v1/topics/:id` | `RequireLogin` + `topic.delete.own` | forum | 软删 + 删楼层 + 删票 |
| POST | `/api/v1/topics/:id/lock` | `RequireLogin` + `topic.lock` | forum | body `{ locked }` |
| POST | `/api/v1/topics/:id/pin` | `RequireLogin` + `topic.pin` | forum | body `{ pinned }` |
| POST | `/api/v1/topics/:id/feature` | `RequireLogin` + `topic.pin` | forum | body `{ featured }` |
| GET | `/api/v1/topics/:id/posts` | 无 | forum | 游标；带 `my_vote` 与楼中楼预览 |
| POST | `/api/v1/topics/:id/posts` | `RequireLogin` + `topic.create` | forum | `parent_id?` 只允许一级 |
| PATCH | `/api/v1/posts/:id` | `RequireLogin` + `topic.edit.own` | forum | — |
| DELETE | `/api/v1/posts/:id` | `RequireLogin` + `topic.delete.own` | forum | — |
| GET | `/api/v1/posts/:id/replies` | 无 | forum | 楼中楼，`LIMIT 200` |
| PUT / DELETE | `/api/v1/posts/:id/vote` | `RequireLogin` | forum | `{ value: 1 | -1 }` |
| PUT / DELETE | `/api/v1/issue-comments/:id/vote` | `RequireLogin` | forum | 同一套字段 |
| PUT / DELETE | `/api/v1/topics/:id/like` | `RequireLogin` | forum | 主题只有赞 |
| PUT / DELETE | `/api/v1/topics/:id/bookmark` | `RequireLogin` | forum | — |
| GET | `/api/v1/me/bookmarks` | `RequireLogin` | forum | 游标 |
| PUT / DELETE | `/api/v1/users/:handle/block` | `RequireLogin` | forum | — |
| GET | `/api/v1/topics/:tid/sources/:sid/go` | 无 + 限流 30/min/IP | forum | **302**，计数进 counter |
| POST / PATCH | `/api/v1/topics/:id/sources[/:sid]` | `RequireLogin` + `topic.edit.own` | forum | — |
| DELETE | `/api/v1/topics/:id/sources/:sid` | `RequireLogin` + `topic.edit.own` | forum | — |
| POST | `/api/v1/topics/:id/sources/:sid/verify` | `RequireLogin` + `topic.edit.own` | forum | `verified_at = now, upkeep = active` |
| GET | `/api/v1/topics/:id/issues` | 无 | forum | `?status=&kind=&author=&q=&sort=&limit=&cursor=` |
| POST | `/api/v1/topics/:id/issues` | `RequireLogin` + `topic.create` | forum | `{ kind, title, body_md }` |
| GET | `/api/v1/issues` | 无 | forum | **跨主题聚合**（进 v1） |
| GET | `/api/v1/issues/:id` | 无 | forum | 详情（含 `body_html`、`assignee`、`tags`） |
| PATCH | `/api/v1/issues/:id` | `RequireLogin` + `topic.edit.own` | forum | 关/开、改标题正文、指派 |
| GET / POST | `/api/v1/issues/:id/comments` | 无 / `RequireLogin` + `topic.create` | forum | **只有 GET 与 POST** |
| GET | `/api/v1/issue-comments/:id/replies` | 无 | forum | 楼中楼 |
| GET | `/api/v1/search` | 无 | **forum**（能力来自 `platform/search`，D5） | `?q=&type=topics|users&board=&limit=&cursor=` |

**`POST /api/v1/topics/:id/images` 与 `DELETE .../images/:hash` 归 media（D5），不在这里** —— `topic_images` 是 D5 的表（D5 §4.1）。
**`/admin/boards*` 归 D2**：它用本域的表与本域的列定义，端点属管理域。
**请求体上限按路由设**（`http.MaxBytesReader`），不许全局一刀切。

---

## 3. 我依赖别人的什么

| 依赖 | 谁提供 | 形状（我这边定义的接口） | 用途 | 触发时点 |
|---|---|---|---|---|
| 当前身份 | D1 auth/authz | `*authz.Actor`（显式入参，拍板 §5.3） | 全部写操作与可见性判定 | 每请求 |
| 权限点常量 | D1 authz | `PermTopicCreate` / `PermTopicEditOwn` / `PermTopicDeleteOwn` / `PermTopicDeleteAny` / `PermTopicLock` / `PermTopicPin` / `PermTopicMove` | 路由声明 + service 兜底 | — |
| 用户 basic | D1 user | `UserLookup.GetBriefs` / `ByHandle`（D4 §3.2 已有同款） | 列表作者、`?author=` | 每次列表 |
| 用户 auth 摘要 | D1 user | `UserLookup.GetAuthBrief` → `{Trusted, Level, Status}` | 审核豁免、发帖门槛 | 发主题/回复 |
| 事务入口 | platform/db | `WithTx(ctx, client, fn)` | 全部多表写 | — |
| 队列 | platform/queue | `EnqueueTx(ctx, tx, Task)`、`TypeSearchIndex` / `TypeNotifyReply` / `TypeNotifyMention` / `TypeNotifyReview` / `TypeNotifyLike` | 索引与通知 | 设计 §8.3 |
| 计数器 | platform/counter | `Add(key, delta)` / `Get(key)` + 15 秒写回回调 | `view_count`、`go_count` | 详情页、转链 |
| 时钟 | platform/clock | `Now()` | 全部时间 | — |
| Markdown 渲染 | platform/markdown | `Render(md) (html, plain string)` | `content_html` + `excerpt` + `body_text` | 发帖/编辑/发 issue |
| @提及解析 | platform/mention（D4 §5.6） | `Parse(md) []int64` | 通知与校验 | 发帖/编辑 |
| 图片引用 | D5 media | `ImageRef.DropTopicImagesTx(ctx, tx, topicID)` | 删主题时的引用计数 | 删主题 |
| 搜索写入 | D5 platform/search | `Indexer.UpsertTopic` / `DeleteTopic`（由 `search:index` 任务调，**本域只投递**） | 索引不漂移 | 设计 §8.3 |
| 审计 | D6 | `AuditSink.Write(ctx, tx, entry)` | 锁 / 置顶 / 移动 / 审核 / 禁言 | 危险写操作 |
| 限流 | platform/ratelimit | `Allow(key, limit, window)` | 转链端点（30/min/IP） | 每次 302 |

**我提供给别人**：`forum.Service`（业务方法）、`BlockedBetween`（D4 message）、`ResolveTargetOwner`（D6 reports）。
**本域刻意不导出**：没有 `HasPerm` 之类的转发、没有单独的 `GetTopicBoardID`（需要 board_id 的地方直接用 `TopicDetail`）。

---

## 4. 数据库归属：本域要写的迁移

| 迁移文件 | 内容 | ent schema 能不能生成 |
|---|---|---|
| `0005_forum.sql` | 本域 **12 张表**（boards / board_acls / board_moderators / topics / posts / topic_sources / post_issues / issue_comments / likes / bookmarks / blocks / sanctions）+ 全部索引 | 表与普通索引能。**必须手写**：全部 CHECK；12 个带谓词的部分索引（`idx_topics_recent`、`idx_topics_board_live`、`idx_topics_board_new`、`idx_topics_kind_new`、`idx_topics_featured`、`idx_topics_pinned`、`idx_topics_review_queue`、`uq_topics_author_client_token`、`uq_posts_author_client_token`、`uq_post_issues_author_client_token`、`idx_post_issues_assignee` 以及 `posts` 的两个唯一索引）；`text[]` 的默认值 `'{}'`；`tags` 的 GIN |
| `0006_issue_search.sql` | `post_issues` 加 `tsv tsvector` **生成列**（`setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body_text), 'B')`） | **不能**（生成列 ent 表达不了）；**不建 GIN**（设计 §7.8 的理由：全站 issue 量级 + `status` 索引已把候选压小） |

**不是本域的迁移**（登记以免重复建表）：`topic_images`（D5 `0002_media.sql`）、`images`（D5）、`topic_search`（D5 `0004_search.sql`）、`reports`（D6）。

### 4.1 与 D5 的一处交界（迁移顺序会炸，必须一起定）

`topic_images` 有外键指向 `topics(id)`，而 `topics` 在 `0005_forum.sql`；D5 的 `0002_media.sql` 排在前面。**空库跑迁移会在 0002 就失败。**

| 出路 | 代价 |
|---|---|
| ①（倾向）把 `topic_images` 挪进 `0005_forum.sql` | 它逻辑上就是论坛的关联表：两个读路径（封面、详情图集）都在本域，D5 只提供写端点。代价：改 D5 的迁移文件内容 |
| ② 保持 D5 拥有，把 `topics` 建表挪到 `0001` | 把一张论坛表放进平台迁移，`0001` 会变成大杂烩 |
| ③ 把 `topic_images` 改成不带外键 | 丢掉级联删除，违反「外键必须显式建索引」那一节的整个前提。**不选** |

**这条需要 Lead 定**，因为它要动 D5 已经写好的迁移文件编号。

---

## 5. 未决问题（与设计 §12.3 同一份，这里列**需要谁拍**）

| # | 问题 | 需要谁 | 不定的后果 |
|---|---|---|---|
| 1 | `topic_images` 归 D5 还是归本域（迁移编号与顺序，见 §4.1） | Lead + D5 | 空库跑迁移直接失败 |
| 2 | 评论的 `?sort=hot` 要不要跨页（设计 §12.3-5） | 界面（W2 / W3） | 界面以为「最热」是全部评论里最热，后端只给了当前页 |
| 3 | `topic_sources.provider` 要不要 CHECK（设计 §12.3-2） | Lead | 库里出现 `百度` 这类值，前端回落成一排问号 |
| 4 | `bookmark_count` 要不要返回（设计 §12.3-7） | 界面（W2） | 图上真有这个数字时前端拿不到 |
| 5 | `min_post_level = 1` 等于不限（设计 §12.3-6） | 产品 | 后台填 1 以为设了门槛 |
| 6 | `idx_posts_roots` 要不要现在建（设计 §12.3-3） | Lead（写放大 vs 大帖的 Filter 成本） | 大帖的顶层回复列表多扫一些行 |
| 7 | `POST /api/v1/topics` 的体上限（本文按 256KB 写） | Lead | 上限太低会拦掉长正文 |
| 8 | 新主题/新回复要不要发通知邮件（本域只投 `notify:*` 任务） | D4 | 两边都以为对方在发，或者两边都发 |
| 9 | 发主题时的配图走事务还是走独立端点（设计 §12.3-9） | Lead + D5 | 两处实现打架：发帖事务挂图 vs `POST /posts/{id}/images` |

---

## 6. 实现时最容易写错的五处（按出错概率排序）

| # | 坑 | 正确的做法 |
|---|---|---|
| 1 | 游标第一页传 `NULL` | 传 `'infinity'::timestamptz` 与 `9223372036854775807`；行比较遇 NULL 会**静默返回零行**（设计 §3.2、§11.4 第 3 条有专门的测试） |
| 2 | 列表忘了过滤 `review_state` | 四条列表都要 `visibility='normal' AND review_state='approved'` 或 `author_id = $me`（设计 §3.2） |
| 3 | 计数写成 `reply_count = reply_count + 1` | 用重算（设计 §3.7 Q8a）：增量要在四条路径上各写一遍补偿，一处漏写就永久漂移 |
| 4 | 投票写成「先查再写」 | 用 `ON CONFLICT ... DO UPDATE ... WHERE value IS DISTINCT FROM EXCLUDED.value` 的 CAS（设计 §5.1） |
| 5 | 置顶帖混进游标列表 | 置顶单独一条查询（设计 §3.3 Q2b），否则置顶帖会在**每一页**出现一次 |

---

## 7. 验收怎么证明它真的工作（最少一组）

| 命令 / 动作 | 期望 |
|---|---|
| 空库 → `forum migrate` → `forum migrate`（再跑一次） | 两次都成功（幂等） |
| 迁移后跑 §11.2 的 7 条自检 SQL | 全部零行 |
| 造 10 万主题 + 1 万帖子，跑 §11.1 的 12 条 EXPLAIN 断言 | 无 `Seq Scan on topics/posts`，无 `Sort`（第 3、6 条） |
| 并发 20 个人同时回复同一主题 | `floor` 无重复、`reply_count = 20` |
| 并发 20 次同一个 `client_token` 发帖 | 只产生 1 个主题 |
| 游客拉 10 页分区列表 | 看不到任何 pending/rejected/hidden/deleted 的帖子 |
| 作者删掉自己的 pending 主题 | 从自己的主页列表里消失，别人的列表里从来就没出现过 |

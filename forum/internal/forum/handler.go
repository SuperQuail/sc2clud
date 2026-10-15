package forum

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// Handler 是本域的 HTTP 层。**只做四件事**：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
// 任何业务分支都不许写在这里（方案 §4.2）。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

// ActorFunc 由 app 层注入：从 gin 上下文里取出已经装配好的 Actor（D2 的 LoadPrincipal 产物）。
// 游客返回 nil——「谁是游客」由本域按 nil 处理，不引入第二个哨兵。
type ActorFunc func(c *gin.Context) *authz.Actor

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// 请求体上限按路由设（拍板：不许全局一刀切）。
const (
	maxTopicBody = 256 << 10 // 发主题 / 改主题：长正文
	maxWriteBody = 32 << 10  // 回复、评论、下载源、Issue
)

// Register 挂上本域的全部路由。
// requireLogin 与 perm 由 app 层注入（D2 的中间件），本域不 import auth 域。
//
// 中间件只挂全局权限点；作用域权限（board.moderate）与归属判定在 service 里判（拍板 §1.2）。
// **自带中间件的路由**（如收藏页要登录）用 rg.GET(path, requireLogin, h.xxx) 的三段式。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc, perm func(string) gin.HandlerFunc) {
	// 路径参数里的 {id} / {sid} 都是对外 ID（uuid），非 uuid 一律挡成 400：
	// 它们会进 SQL 的 uuid 比较，放过去就是 PostgreSQL 22P02 → 500（D3）。
	//
	// **闸挂在读组上，写路由逐条挂在「身份 → 权限」之后**（拍板 08 · C9-3：先验身份再验路径 ID）。
	// 这个顺序差决定未登录的非 uuid 请求拿 401 还是 400：
	//   · 公开读没有身份可验，格式先判 → 400（C9-1：语义统一成 400）；
	//   · 写路由先吃 requireLogin，未登录的非 uuid 请求 → **401**，登录了才轮到格式判定 → 400。
	//
	// 读组用 Group 一次挂完（「每条新路由都记得写」的规则等于没有规则）；写路由走 w() ——
	// 路径闸是它的位置参数，漏写就是参数个数不对，不再是「忘了写一行」。
	read := rg.Group("", httpx.ValidPathIDs("id", "sid"))
	w := func(plate string, mw ...gin.HandlerFunc) []gin.HandlerFunc {
		if !strings.HasPrefix(plate, "/") {
			panic("forum: 路由模板必须以 / 开头：" + plate)
		}
		return mw
	}

	// ---- 公开读 ----
	read.GET("/boards", h.listBoards)
	read.GET("/boards/:slug", h.getBoard)
	read.GET("/topics", h.listTopics)
	read.GET("/topics/:id", h.getTopic)
	read.GET("/topics/:id/posts", h.listPosts)
	read.GET("/topics/:id/issues", h.listTopicIssues)
	read.GET("/issues", h.listIssues)
	// 类型值域（拍板 08 · J6 的落地缺口：Service.IssueKinds 一直有实现却没挂路由，
	// 于是前端只能写死四类）。**游客可读**：新建入口与筛选下拉在未登录时也要画得出来。
	// 注册在 /issues/:id 之前只是让读的人看见顺序，gin 的静态段本来就优先于通配段。
	read.GET("/issues/kinds", h.listIssueKinds)
	read.GET("/issues/:id", h.getIssue)
	read.GET("/issues/:id/comments", h.listIssueComments)
	read.GET("/posts/:id/replies", h.listReplies)
	read.GET("/issue-comments/:id/replies", h.listIssueCommentReplies)
	// 个人主页的作品列表。**这条路由以前根本不存在** —— Service 有 ListUserTopics 的实现却没挂路由，
	// 前端 GET /users/{handle}/topics 落到 NoRoute（返回 200 + SPA 壳），于是页面上「最近发布」
	// 永远停在「正在加载帖子…」（2026-10-13 实测）。
	read.GET("/users/:handle/topics", h.listUserTopics)
	read.GET("/topics/:id/sources", h.listSources)
	// 参数名必须与上面那组一致（gin 不允许同一层出现两个不同的通配名）。
	read.GET("/topics/:id/sources/:sid/go", h.goSource) // 302

	// ---- 写 ----
	rg.POST("/topics", w("/topics", requireLogin, perm(authz.PermTopicCreate), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxTopicBody), h.createTopic)...)
	rg.PATCH("/topics/:id", w("/topics/:id", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxTopicBody), h.updateTopic)...)
	rg.DELETE("/topics/:id", w("/topics/:id", requireLogin, perm(authz.PermTopicDeleteOwn), httpx.ValidPathIDs("id", "sid"), h.deleteTopic)...)
	rg.POST("/topics/:id/lock", w("/topics/:id/lock", requireLogin, perm(authz.PermTopicLock), httpx.ValidPathIDs("id", "sid"), h.lockTopic)...)
	rg.POST("/topics/:id/pin", w("/topics/:id/pin", requireLogin, perm(authz.PermTopicPin), httpx.ValidPathIDs("id", "sid"), h.pinTopic)...)
	rg.POST("/topics/:id/feature", w("/topics/:id/feature", requireLogin, perm(authz.PermTopicPin), httpx.ValidPathIDs("id", "sid"), h.featureTopic)...)
	rg.POST("/topics/:id/posts", w("/topics/:id/posts", requireLogin, perm(authz.PermTopicCreate), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.createPost)...)
	rg.PATCH("/posts/:id", w("/posts/:id", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.updatePost)...)
	rg.DELETE("/posts/:id", w("/posts/:id", requireLogin, perm(authz.PermTopicDeleteOwn), httpx.ValidPathIDs("id", "sid"), h.deletePost)...)
	rg.PUT("/posts/:id/vote", w("/posts/:id/vote", requireLogin, httpx.ValidPathIDs("id", "sid"), h.votePost)...)
	rg.DELETE("/posts/:id/vote", w("/posts/:id/vote", requireLogin, httpx.ValidPathIDs("id", "sid"), h.unvotePost)...)
	rg.PUT("/issue-comments/:id/vote", w("/issue-comments/:id/vote", requireLogin, httpx.ValidPathIDs("id", "sid"), h.voteIssueComment)...)
	rg.DELETE("/issue-comments/:id/vote", w("/issue-comments/:id/vote", requireLogin, httpx.ValidPathIDs("id", "sid"), h.unvoteIssueComment)...)
	rg.PUT("/topics/:id/like", w("/topics/:id/like", requireLogin, httpx.ValidPathIDs("id", "sid"), h.likeTopic)...)
	rg.DELETE("/topics/:id/like", w("/topics/:id/like", requireLogin, httpx.ValidPathIDs("id", "sid"), h.unlikeTopic)...)
	rg.PUT("/topics/:id/bookmark", w("/topics/:id/bookmark", requireLogin, httpx.ValidPathIDs("id", "sid"), h.bookmarkTopic)...)
	rg.DELETE("/topics/:id/bookmark", w("/topics/:id/bookmark", requireLogin, httpx.ValidPathIDs("id", "sid"), h.unbookmarkTopic)...)
	rg.GET("/me/bookmarks", requireLogin, h.listBookmarks)
	rg.POST("/topics/:id/issues", w("/topics/:id/issues", requireLogin, perm(authz.PermTopicCreate), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.createIssue)...)
	// **不挂 perm(topic.edit.own)**：能改一条 Issue 的人有四种（作者 / 版主 / 管理员及以上 /
	// Issue 发布者，拍板 08 · J8），路由级中间件只判得了「这类动作允不允许」，判不了
	// 「这条是不是我的、我是不是版主」。四档判定在 service 的 canEditTopic / canCloseIssue 里，
	// 与「作用域权限不进中间件」是同一条规矩（拍板 §1.2）。
	rg.PATCH("/issues/:id", w("/issues/:id", requireLogin, httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.updateIssue)...)
	rg.POST("/issues/:id/comments", w("/issues/:id/comments", requireLogin, perm(authz.PermTopicCreate), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.createIssueComment)...)
	rg.POST("/topics/:id/sources", w("/topics/:id/sources", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.saveSource)...)
	rg.PATCH("/topics/:id/sources/:sid", w("/topics/:id/sources/:sid", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), httpx.BodyLimit(maxWriteBody), h.updateSource)...)
	rg.DELETE("/topics/:id/sources/:sid", w("/topics/:id/sources/:sid", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), h.deleteSource)...)
	rg.POST("/topics/:id/sources/:sid/verify", w("/topics/:id/sources/:sid/verify", requireLogin, perm(authz.PermTopicEditOwn), httpx.ValidPathIDs("id", "sid"), h.verifySource)...)
	rg.PUT("/users/:handle/block", requireLogin, h.blockUser)
	rg.DELETE("/users/:handle/block", requireLogin, h.unblockUser)

	// ---- 人工审核队列（2026-10-14 补；契约见 完全重构/进行中/后端接口对账.md）----
	// 挂在 /admin 下：判据是全局权限点 post.review，与「作者也能做」的那批动作不是一回事。
	// 中间件只判权限点；「这条主题在不在、可不可判」在 service 里判（拍板 §1.2）。
	rg.GET("/admin/topics", requireLogin, perm(authz.PermPostReview), h.listReviewQueue)
	rg.POST("/admin/topics/:id/review", w("/admin/topics/:id/review", requireLogin, perm(authz.PermPostReview), httpx.ValidPathIDs("id", "sid"), h.reviewTopic)...)

	// ---- 分区管理（C2；界面需求 §5.3 + §5.10）。权限点一律 board.manage ----
	//
	// 路径参数 {id} 是分区的**对外 ID（uuid）**：boards 只有自增主键，0025 才补的 public_id。
	// 所以这批路由与上面那批一样要过 ValidPathIDs —— 少了它，非 uuid 会进
	// "WHERE public_id = $1" 的 uuid 比较，得到 PostgreSQL 22P02 → 500（D3 那一族）。
	rg.GET("/admin/boards", requireLogin, perm(authz.PermBoardManage), h.adminListBoards)
	rg.POST("/admin/boards", w("/admin/boards", requireLogin, perm(authz.PermBoardManage), httpx.BodyLimit(maxWriteBody), h.adminCreateBoard)...)
	// 重排必须在 :id 之前注册：gin 的静态段优先，但把顺序写对也让读的人不必去想这件事。
	rg.POST("/admin/boards/reorder", w("/admin/boards/reorder", requireLogin, perm(authz.PermBoardManage), httpx.BodyLimit(maxWriteBody), h.adminReorderBoards)...)
	rg.PATCH("/admin/boards/:id", w("/admin/boards/:id", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminUpdateBoard)...)
	rg.GET("/admin/boards/:id/acl", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), h.adminBoardACL)
	rg.PUT("/admin/boards/:id/acl", w("/admin/boards/:id/acl", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminReplaceBoardACL)...)
	rg.GET("/admin/boards/:id/moderators", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), h.adminBoardModerators)

	// ---- 用户组（D38）。组与组员走 user.ban（动的是「谁在哪个组」）；分区的组矩阵与
	// 角色矩阵同闸 board.manage。{id}/{uid} 都是对外 uuid，非 uuid 同样挡成 400（D3 同族）。
	rg.GET("/admin/groups", requireLogin, perm(authz.PermUserBan), h.adminListGroups)
	rg.POST("/admin/groups", w("/admin/groups", requireLogin, perm(authz.PermUserBan), httpx.BodyLimit(maxWriteBody), h.adminCreateGroup)...)
	rg.PATCH("/admin/groups/:id", w("/admin/groups/:id", requireLogin, perm(authz.PermUserBan), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminUpdateGroup)...)
	rg.DELETE("/admin/groups/:id", w("/admin/groups/:id", requireLogin, perm(authz.PermUserBan), httpx.ValidPathIDs("id"), h.adminDeleteGroup)...)
	rg.GET("/admin/groups/:id/members", requireLogin, perm(authz.PermUserBan), httpx.ValidPathIDs("id"), h.adminGroupMembers)
	rg.POST("/admin/groups/:id/members", w("/admin/groups/:id/members", requireLogin, perm(authz.PermUserBan), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminAddGroupMember)...)
	rg.DELETE("/admin/groups/:id/members/:uid", w("/admin/groups/:id/members/:uid", requireLogin, perm(authz.PermUserBan), httpx.ValidPathIDs("id", "uid"), h.adminRemoveGroupMember)...)
	rg.GET("/admin/boards/:id/group-acl", w("/admin/boards/:id/group-acl", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), h.adminBoardGroupACL)...)
	rg.PUT("/admin/boards/:id/group-acl", w("/admin/boards/:id/group-acl", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminReplaceBoardGroupACL)...)
	rg.POST("/admin/boards/:id/moderators", w("/admin/boards/:id/moderators", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id"), httpx.BodyLimit(maxWriteBody), h.adminGrantBoardModerator)...)
	rg.DELETE("/admin/boards/:id/moderators/:uid", w("/admin/boards/:id/moderators/:uid", requireLogin, perm(authz.PermBoardManage), httpx.ValidPathIDs("id", "uid"), h.adminRevokeBoardModerator)...)
}

// ---- 读 ----

func (h *Handler) listBoards(c *gin.Context) {
	out, err := h.svc.ListBoards(c.Request.Context(), h.actor(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) getBoard(c *gin.Context) {
	out, err := h.svc.BoardBySlug(c.Request.Context(), c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type listTopicsQuery struct {
	Board  string `form:"board"`
	Kind   string `form:"kind"`
	Sort   string `form:"sort"`
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

func (h *Handler) listTopics(c *gin.Context) {
	var q listTopicsQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListTopics(c.Request.Context(), h.actor(c), ListTopicsInput{
		Board: q.Board, Kind: q.Kind, Sort: q.Sort, Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

type reviewQueueQuery struct {
	State  string `form:"state"`
	Board  string `form:"board"`
	Q      string `form:"q"`
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

func (h *Handler) listReviewQueue(c *gin.Context) {
	var q reviewQueueQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListReviewQueue(c.Request.Context(), h.actor(c), ReviewQueueInput{
		State: q.State, Board: q.Board, Q: q.Q, Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

type reviewTopicBody struct {
	Action string `json:"action" binding:"required"`
	Note   string `json:"note"`
	// 审核员看队列时那一版的 updated_at（队列项里就有）。**必填**：
	// 它是这一层的信任边界 —— 不带版本就没有办法证明「批的是你看过的那一份内容」。
	ExpectedUpdatedAt time.Time `json:"expected_updated_at" binding:"required"`
}

func (h *Handler) reviewTopic(c *gin.Context) {
	var b reviewTopicBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ReviewTopic(c.Request.Context(), h.actor(c), c.Param("id"), b.Action, b.Note, b.ExpectedUpdatedAt)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) listUserTopics(c *gin.Context) {
	var q struct {
		Cursor string `form:"cursor"`
		Limit  int    `form:"limit"`
	}
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListUserTopics(c.Request.Context(), h.actor(c), c.Param("handle"), PageInput{Cursor: q.Cursor, Limit: q.Limit})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) getTopic(c *gin.Context) {
	out, err := h.svc.TopicDetail(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type pageQuery struct {
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

func (h *Handler) listPosts(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListPosts(c.Request.Context(), h.actor(c), ListPostsInput{
		TopicPublicID: c.Param("id"), Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) listReplies(c *gin.Context) {
	out, err := h.svc.ListReplies(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) listBookmarks(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListBookmarks(c.Request.Context(), h.actor(c), PageInput{Cursor: q.Cursor, Limit: q.Limit})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) listSources(c *gin.Context) {
	out, err := h.svc.ListSources(c.Request.Context(), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// goSource 是唯一的 302：限流 30/分钟/IP 在这里做（service 看不到 IP）。
func (h *Handler) goSource(c *gin.Context) {
	ctx := c.Request.Context()
	if h.svc.deps.Limit != nil {
		ok, retry, err := h.svc.deps.Limit.Allow(ctx, "forum:go:"+c.ClientIP(), 30, time.Minute)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if !ok {
			c.Header("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
			httpx.Fail(c, errRateLimited)
			return
		}
	}
	url, err := h.svc.GoSource(ctx, c.Param("id"), c.Param("sid"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// no-store：转链是一次有副作用的跳转，不能被中间层缓存（§7.2）。
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, url)
}

// ---- 写 ----

type createTopicBody struct {
	BoardSlug   string `json:"board" binding:"required"`
	Kind        string `json:"kind"`
	Title       string `json:"title" binding:"required"`
	ContentMD   string `json:"content_md" binding:"required"`
	ClientToken string `json:"client_token"`
}

func (h *Handler) createTopic(c *gin.Context) {
	var b createTopicBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.CreateTopic(c.Request.Context(), h.actor(c), CreateTopicInput{
		BoardSlug: b.BoardSlug, Kind: b.Kind, Title: b.Title, ContentMD: b.ContentMD, ClientToken: b.ClientToken,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

type updateTopicBody struct {
	Title          *string `json:"title"`
	ContentMD      *string `json:"content_md"`
	Board          *string `json:"board"`
	Kind           *string `json:"kind"`
	ResourceStatus *string `json:"resource_status"`
}

func (h *Handler) updateTopic(c *gin.Context) {
	var b updateTopicBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	err := h.svc.UpdateTopic(c.Request.Context(), h.actor(c), c.Param("id"), UpdateTopicInput{
		Title: b.Title, ContentMD: b.ContentMD, BoardSlug: b.Board, Kind: b.Kind, ResourceStatus: b.ResourceStatus,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) deleteTopic(c *gin.Context) {
	if err := h.svc.DeleteTopic(c.Request.Context(), h.actor(c), c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type lockBody struct {
	Locked bool `json:"locked"`
}

func (h *Handler) lockTopic(c *gin.Context) {
	var b lockBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.LockTopic(c.Request.Context(), h.actor(c), c.Param("id"), b.Locked); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

type pinBody struct {
	Pinned bool `json:"pinned"`
}

type featureBody struct {
	Featured bool `json:"featured"`
}

func (h *Handler) pinTopic(c *gin.Context) {
	var b pinBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.PinTopic(c.Request.Context(), h.actor(c), c.Param("id"), "pin", b.Pinned); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) featureTopic(c *gin.Context) {
	var b featureBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.PinTopic(c.Request.Context(), h.actor(c), c.Param("id"), "feature", b.Featured); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

type createPostBody struct {
	ContentMD   string `json:"content_md" binding:"required"`
	ParentID    string `json:"parent_id"`
	ClientToken string `json:"client_token"`
}

func (h *Handler) createPost(c *gin.Context) {
	var b createPostBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.CreatePost(c.Request.Context(), h.actor(c), c.Param("id"), CreatePostInput{
		ContentMD: b.ContentMD, ParentID: b.ParentID, ClientToken: b.ClientToken,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

type updatePostBody struct {
	ContentMD string `json:"content_md" binding:"required"`
}

func (h *Handler) updatePost(c *gin.Context) {
	var b updatePostBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.UpdatePost(c.Request.Context(), h.actor(c), c.Param("id"), b.ContentMD); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) deletePost(c *gin.Context) {
	if err := h.svc.DeletePost(c.Request.Context(), h.actor(c), c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type voteBody struct {
	Value int `json:"value"`
}

func (h *Handler) votePost(c *gin.Context)         { h.vote(c, VotePost) }
func (h *Handler) voteIssueComment(c *gin.Context) { h.vote(c, VoteIssueComment) }
func (h *Handler) likeTopic(c *gin.Context)        { h.voteValue(c, VoteTopic, 1) }

func (h *Handler) vote(c *gin.Context, target VoteTarget) {
	var b voteBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.voteValue(c, target, b.Value)
}

func (h *Handler) voteValue(c *gin.Context, target VoteTarget, value int) {
	out, err := h.svc.Vote(c.Request.Context(), h.actor(c), target, c.Param("id"), value)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) unvotePost(c *gin.Context)         { h.unvote(c, VotePost) }
func (h *Handler) unvoteIssueComment(c *gin.Context) { h.unvote(c, VoteIssueComment) }
func (h *Handler) unlikeTopic(c *gin.Context)        { h.unvote(c, VoteTopic) }

func (h *Handler) unvote(c *gin.Context, target VoteTarget) {
	out, err := h.svc.Unvote(c.Request.Context(), h.actor(c), target, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) bookmarkTopic(c *gin.Context)   { h.bookmark(c, true) }
func (h *Handler) unbookmarkTopic(c *gin.Context) { h.bookmark(c, false) }

func (h *Handler) bookmark(c *gin.Context, on bool) {
	if err := h.svc.Bookmark(c.Request.Context(), h.actor(c), c.Param("id"), on); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) blockUser(c *gin.Context)   { h.block(c, true) }
func (h *Handler) unblockUser(c *gin.Context) { h.block(c, false) }

func (h *Handler) block(c *gin.Context, on bool) {
	if err := h.svc.BlockUser(c.Request.Context(), h.actor(c), c.Param("handle"), on); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

type sourceBody struct {
	Provider       string  `json:"provider" binding:"required"`
	Label          string  `json:"label"`
	URL            string  `json:"url" binding:"required"`
	ExtractionCode *string `json:"extraction_code"`
	Size           string  `json:"size"`
}

func (h *Handler) saveSource(c *gin.Context) {
	var b sourceBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	in := SourceInput{Provider: b.Provider, Label: b.Label, URL: b.URL, ExtractionCode: b.ExtractionCode, Size: b.Size}
	out, err := h.svc.SaveSource(c.Request.Context(), h.actor(c), c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) updateSource(c *gin.Context) {
	var b sourceBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	in := SourceInput{Provider: b.Provider, Label: b.Label, URL: b.URL, ExtractionCode: b.ExtractionCode, Size: b.Size}
	out, err := h.svc.UpdateSource(c.Request.Context(), h.actor(c), c.Param("id"), c.Param("sid"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) deleteSource(c *gin.Context) {
	if err := h.svc.DeleteSource(c.Request.Context(), h.actor(c), c.Param("sid")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) verifySource(c *gin.Context) {
	if err := h.svc.VerifySource(c.Request.Context(), h.actor(c), c.Param("sid")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

type listIssuesQuery struct {
	Q        string `form:"q"`
	Status   string `form:"status"`
	Kind     string `form:"kind"`
	Author   string `form:"author"`
	Assignee string `form:"assignee"`
	Sort     string `form:"sort"`
	Cursor   string `form:"cursor"`
	Limit    int    `form:"limit"`
}

func (h *Handler) listTopicIssues(c *gin.Context) { h.listIssuesAt(c, c.Param("id")) }
func (h *Handler) listIssues(c *gin.Context)      { h.listIssuesAt(c, "") }

func (h *Handler) listIssuesAt(c *gin.Context, topicPublicID string) {
	var q listIssuesQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	if q.Assignee != "" && q.Assignee != "me" {
		httpx.Fail(c, invalid("assignee", "只能是 me"))
		return
	}
	page, err := h.svc.ListIssues(c.Request.Context(), h.actor(c), ListIssuesInput{
		TopicPublicID: topicPublicID, Q: q.Q, Status: q.Status, Kind: q.Kind, Author: q.Author,
		AssigneeMe: q.Assignee == "me", Sort: q.Sort, Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

// listIssueKinds 是 GET /issues/kinds：值域的唯一来源（issue_kinds 表）。
// 返回 { data: [...] }（httpx.OKList 的列表形状，与其它列表一致，前端 apiList 直接吃）。
func (h *Handler) listIssueKinds(c *gin.Context) {
	out, err := h.svc.IssueKinds(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out, "")
}

func (h *Handler) getIssue(c *gin.Context) {
	out, err := h.svc.IssueDetail(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type createIssueBody struct {
	Kind        string `json:"kind" binding:"required"`
	Title       string `json:"title" binding:"required"`
	BodyMD      string `json:"body_md" binding:"required"`
	ClientToken string `json:"client_token"`
}

func (h *Handler) createIssue(c *gin.Context) {
	var b createIssueBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.CreateIssue(c.Request.Context(), h.actor(c), c.Param("id"), CreateIssueInput{
		Kind: b.Kind, Title: b.Title, BodyMD: b.BodyMD, ClientToken: b.ClientToken,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

type updateIssueBody struct {
	Title    *string `json:"title"`
	BodyMD   *string `json:"body_md"`
	Status   *string `json:"status"`
	Assignee *string `json:"assignee"`
}

func (h *Handler) updateIssue(c *gin.Context) {
	var b updateIssueBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	err := h.svc.UpdateIssue(c.Request.Context(), h.actor(c), c.Param("id"), UpdateIssueInput{
		Title: b.Title, BodyMD: b.BodyMD, Status: b.Status, Assignee: b.Assignee,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

type createCommentBody struct {
	BodyMD   string `json:"body_md" binding:"required"`
	ParentID string `json:"parent_id"`
}

func (h *Handler) listIssueComments(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.ListIssueComments(c.Request.Context(), h.actor(c), c.Param("id"), PageInput{Cursor: q.Cursor, Limit: q.Limit})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) listIssueCommentReplies(c *gin.Context) {
	out, err := h.svc.ListIssueCommentReplies(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) createIssueComment(c *gin.Context) {
	var b createCommentBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.CreateIssueComment(c.Request.Context(), h.actor(c), c.Param("id"), CreateCommentInput{
		BodyMD: b.BodyMD, ParentID: b.ParentID,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// errRateLimited 与 platform/apperr 的 ErrRateLimited 是同一个码：
// 转链端点的 429 要带 Retry-After，所以它单独包一层。
var errRateLimited = apperr.New(apperr.CodeRateLimited, http.StatusTooManyRequests, "请求太频繁，请稍后再试")

package auth

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// Handler 是 HTTP 层。它只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
// **不在 handler 里写业务分支**（拍板 §5.2 / 后端方案 §4）。
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Register 把本域的路由挂到 rg 上。rg 由 app 层给出（本域挂 /api/v1 全前缀，
// LoadPrincipal 也在这里挂上——它必须比任何路由先跑）。
//
// 依赖：只有 *Service。auth 模块不 import 任何业务模块（别人通过 deps.go 的小接口进来）。
func (h *Handler) Register(rg *gin.RouterGroup) {
	svc := h.svc
	// LoadPrincipal 挂在这里而不是引擎上：/static、/healthz、/img/** 不经过它（设计 §6.4）。
	rg.Use(svc.LoadPrincipal())

	login := svc.RequireLogin()
	activated := svc.RequireActivated()

	// 认证（游客可访问）。/captcha 在路由白名单里（设计 §9.2）：它是「还没有身份的人」
	// 唯一能拿到的凭据，挂 RequireLogin 就等于永远拿不到。
	rg.GET("/captcha", h.captcha)
	rg.POST("/auth/register", h.register)
	rg.POST("/auth/login", h.login)
	rg.POST("/auth/email/verify", h.emailVerify)
	rg.POST("/auth/email/resend", login, h.emailResend)
	rg.POST("/auth/password/forgot", h.passwordForgot)
	rg.POST("/auth/password/verify-code", h.passwordVerifyCode)
	rg.POST("/auth/password/reset", h.passwordReset)

	// 我的账号
	rg.GET("/me", h.me)
	rg.POST("/auth/logout", login, h.logout)
	rg.PATCH("/me", login, h.updateProfile)
	rg.POST("/me/password", login, h.changePassword)
	rg.GET("/me/sessions", login, h.listSessions)
	// 路径闸排在 login 之后（拍板 08 · C9-3：先验身份再验路径 ID）。
	// 会话 id 是对外 uuid，非 uuid 放过去会进 SQL 的 uuid 比较 → 22P02 → 500（C9-2）。
	rg.DELETE("/me/sessions/:id", login, httpx.ValidPathIDs("id"), h.revokeSession)

	// 管理：角色与权限（提权类）。管理端是写操作，必须同时挂 RequireActivated
	//（拍板 §9.12：未激活的 admin 不该能提权），顺序 login → activated → Perm（设计 §9.2）。
	// 路径闸在组上（login / activated 之后、每个 Perm 之前）：这些 {id} 全是对外 uuid，
	// 未登录的请求先吃 login 的 401，登录后才轮到格式判定 → 400（拍板 08 · C9-1/C9-3）。
	a := rg.Group("/admin", login, activated, httpx.ValidPathIDs("id"))
	// 用户管理（C1）：读路径同样挂 user.ban —— 它返回邮箱、三根状态轴、处罚与追加权限，
	// 与 /admin/roles 一族不是同一档信息（§5.8 归在「用户与权限」那一组）。
	a.GET("/users", svc.Perm(authz.PermUserBan), h.adminListUsers)
	// 批量在 /users/:id **之前**：gin 的静态段优先于参数段，但把顺序写对也让读的人不必去想这件事。
	a.POST("/users/batch", svc.Perm(authz.PermUserBan), h.adminBatchUsers)
	a.GET("/users/:id", svc.Perm(authz.PermUserBan), h.adminUserDetail)
	a.GET("/roles", svc.Perm(authz.PermRoleEdit), h.adminListRoles)
	a.GET("/permissions", svc.Perm(authz.PermRoleEdit), h.adminListPermissions)
	a.PATCH("/roles/:id/permissions", svc.Perm(authz.PermRoleEdit), h.adminReplaceRolePerms)
	a.PATCH("/users/:id/role", svc.Perm(authz.PermRoleAssign), h.adminSetUserRole)
	a.POST("/users/:id/permissions/:perm", svc.Perm(authz.PermPermissionGrant), h.adminGrantPerm)
	a.DELETE("/users/:id/permissions/:perm", svc.Perm(authz.PermPermissionGrant), h.adminRevokePerm)
	a.POST("/users/:id/ban", svc.Perm(authz.PermUserBan), h.adminBan)
	a.POST("/users/:id/sessions/revoke", svc.Perm(authz.PermUserBan), h.adminRevokeSessions)
	// 自检面板（C3）：debug 关闭时 service 返回 404 common.not_found（不是空 200，§5.13）。
	a.GET("/diagnostics", svc.Perm(authz.PermSiteSetting), h.adminDiagnostics)
	a.GET("/audit-logs", svc.Perm(authz.PermAuditView), h.adminAuditList)
	a.GET("/audit-logs/export", svc.Perm(authz.PermAuditExport), h.adminAuditExport)
}

// ── 请求体（契约真源在本域 dto；字段名就是 JSON 名） ──────────────────────

type registerReq struct {
	Username      string `json:"username" binding:"required"`
	Email         string `json:"email" binding:"required"`
	Password      string `json:"password" binding:"required"`
	Nickname      string `json:"nickname"`
	CaptchaID     string `json:"captcha_id"`
	CaptchaAnswer string `json:"captcha_answer"`
}

type loginReq struct {
	Login         string `json:"login" binding:"required"`
	Password      string `json:"password" binding:"required"`
	CaptchaID     string `json:"captcha_id"`
	CaptchaAnswer string `json:"captcha_answer"`
}

type verifyCodeReq struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Code     string `json:"code" binding:"required"`
}

// loginOf 实现拍板 §11.3 的「username / email 二选一」：都不给或都给都是参数错误。
func (r verifyCodeReq) loginOf() (string, error) {
	switch {
	case r.Username != "" && r.Email != "":
		return "", apperr.Invalid(map[string]string{"username": "username 与 email 只能给一个"})
	case r.Username != "":
		return r.Username, nil
	case r.Email != "":
		return r.Email, nil
	default:
		return "", apperr.Invalid(map[string]string{"username": "请给 username 或 email"})
	}
}

type forgotReq struct {
	Email string `json:"email" binding:"required"`
}

type resetReq struct {
	Ticket      string `json:"reset_ticket" binding:"required"`
	NewPassword string `json:"new_password" binding:"required"`
}

type updateProfileReq struct {
	Nickname *string `json:"nickname"`
	Bio      *string `json:"bio"`
}

type changePasswordReq struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required"`
}

type setRoleReq struct {
	RoleID int64 `json:"role_id" binding:"required"`
}

type replacePermsReq struct {
	PermKeys []string `json:"perm_keys"`
}

// grantPermReq 的 expires_at 是 RFC3339；空表示「永久」（DB 允许 NULL，设计 §8.8）。
type grantPermReq struct {
	Reason    string `json:"reason" binding:"required"`
	ExpiresAt string `json:"expires_at"`
}

type banReq struct {
	Action string `json:"action" binding:"required,oneof=ban unban"`
	Reason string `json:"reason"`
}

// auditQueryReq 是审计列表与导出共用的查询串（游标分页，拍板 §5.1）。
type auditQueryReq struct {
	TargetType string `form:"target_type"`
	TargetID   string `form:"target_id"`
	Action     string `form:"action"`
	Actor      string `form:"actor"`
	From       string `form:"from"`
	To         string `form:"to"`
	Limit      int    `form:"limit"`
	Cursor     string `form:"cursor"`
}

func (r auditQueryReq) toQuery() (AuditQuery, error) {
	q := AuditQuery{
		TargetType: r.TargetType, TargetID: r.TargetID, Action: r.Action,
		ActorPublicID: r.Actor, Limit: r.Limit, Cursor: r.Cursor,
	}
	var err error
	if q.From, err = parseTimePtr(r.From); err != nil {
		return q, err
	}
	if q.To, err = parseTimePtr(r.To); err != nil {
		return q, err
	}
	return q, nil
}

func parseTimePtr(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil, apperr.Invalid(map[string]string{"_": "时间格式必须是 RFC3339"})
	}
	return &t, nil
}

// ── handler ───────────────────────────────────────────────────────

func (h *Handler) register(c *gin.Context) {
	var req registerReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Register(c.Request.Context(), RegisterInput{
		Username: req.Username, Email: req.Email, Password: req.Password, Nickname: req.Nickname,
		CaptchaID: req.CaptchaID, CaptchaAnswer: req.CaptchaAnswer, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) login(c *gin.Context) {
	var req loginReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Login(c.Request.Context(), LoginInput{
		Login: req.Login, Password: req.Password,
		CaptchaID: req.CaptchaID, CaptchaAnswer: req.CaptchaAnswer,
		IP: ClientIP(c), UserAgent: c.Request.UserAgent(),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.svc.setSessionCookie(c, out.Token)
	httpx.OK(c, gin.H{"expires_at": out.ExpiresAt})
}

func (h *Handler) logout(c *gin.Context) {
	p, _ := principalFrom(c)
	if err := h.svc.Logout(c.Request.Context(), p); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.svc.ClearCookie(c)
	httpx.OK(c, nil)
}

// me 是唯一允许游客的 handler：游客拿 data:null，不是 401（设计 §9.2）。
func (h *Handler) me(c *gin.Context) {
	out, err := h.svc.Me(c.Request.Context(), actorFrom(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) updateProfile(c *gin.Context) {
	var req updateProfileReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.UpdateProfile(c.Request.Context(), actorFrom(c), UpdateProfileInput{
		Nickname: req.Nickname, Bio: req.Bio,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) changePassword(c *gin.Context) {
	var req changePasswordReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	err := h.svc.ChangePassword(c.Request.Context(), actorFrom(c), ChangePasswordInput{
		OldPassword: req.OldPassword, NewPassword: req.NewPassword, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// 改密码会删掉当前会话，所以顺手把 Cookie 清掉（下次请求直接是游客，不是「莫名其妙的 401」）。
	h.svc.ClearCookie(c)
	httpx.OK(c, nil)
}

func (h *Handler) listSessions(c *gin.Context) {
	p, _ := principalFrom(c)
	items, err := h.svc.ListSessions(c.Request.Context(), actorFrom(c), p.Digest)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) revokeSession(c *gin.Context) {
	err := h.svc.RevokeSession(c.Request.Context(), actorFrom(c), c.Param("id"))
	if err != nil {
		// 别人的 / 不存在的会话一律 404：它公开接口不区分「不是你的」与「没有这条」
		if err == errSessionNotFound {
			httpx.Fail(c, apperr.ErrNotFound)
			return
		}
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) emailVerify(c *gin.Context) {
	var req verifyCodeReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	login, err := req.loginOf()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	err = h.svc.VerifyEmailCode(c.Request.Context(), VerifyCodeInput{
		Login: login, Code: req.Code, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) emailResend(c *gin.Context) {
	out, err := h.svc.ResendVerify(c.Request.Context(), actorFrom(c), ClientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) passwordForgot(c *gin.Context) {
	var req forgotReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	// 恒 200：不暴露邮箱是否存在（设计 §10.6）。
	if err := h.svc.ForgotPassword(c.Request.Context(), req.Email, ClientIP(c)); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) passwordVerifyCode(c *gin.Context) {
	var req verifyCodeReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	login, err := req.loginOf()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.VerifyResetCode(c.Request.Context(), VerifyCodeInput{
		Login: login, Code: req.Code, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) passwordReset(c *gin.Context) {
	var req resetReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	err := h.svc.ResetPassword(c.Request.Context(), ResetPasswordInput{
		Ticket: req.Ticket, NewPassword: req.NewPassword, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

// ── 管理端 ────────────────────────────────────────────────────────

// ── 用户管理（C1） ───────────────────────────────────────────────

// adminUsersQueryReq 是 GET /admin/users 的查询串。三个布尔筛选是**指针**：
// 不传 = 不筛，false = 「只看没有这一项的」，两者不能合并（三根状态轴是独立的）。
type adminUsersQueryReq struct {
	Q             string `form:"q"`
	Status        string `form:"status"`
	Role          string `form:"role"`
	Activated     *bool  `form:"activated"`
	EmailVerified *bool  `form:"email_verified"`
	Limit         int    `form:"limit"`
	Cursor        string `form:"cursor"`
}

func (h *Handler) adminListUsers(c *gin.Context) {
	var req adminUsersQueryReq
	if err := httpx.BindQuery(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	items, next, err := h.svc.ListAdminUsers(c.Request.Context(), actorFrom(c), AdminUsersQuery{
		Q: req.Q, Status: req.Status, Role: req.Role,
		Activated: req.Activated, EmailVerified: req.EmailVerified,
		Limit: req.Limit, Cursor: req.Cursor,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, items, next)
}

// batchUsersReq 是 POST /admin/users/batch 的体（§5.1 定的形状）。
type batchUsersReq struct {
	IDs    []string `json:"ids" binding:"required"`
	Action string   `json:"action" binding:"required"`
	RoleID int64    `json:"role_id"`
	Reason string   `json:"reason"`
}

func (h *Handler) adminBatchUsers(c *gin.Context) {
	var req batchUsersReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.BatchUsers(c.Request.Context(), actorFrom(c), BatchUsersInput{
		IDs: req.IDs, Action: req.Action, RoleID: req.RoleID, Reason: req.Reason, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) adminUserDetail(c *gin.Context) {
	out, err := h.svc.AdminUserDetail(c.Request.Context(), actorFrom(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// adminDiagnostics 是自检面板（C3）。它**只读**：任何「一键修复」都不在网页上做。
func (h *Handler) adminDiagnostics(c *gin.Context) {
	out, err := h.svc.AdminDiagnostics(c.Request.Context(), actorFrom(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) adminListRoles(c *gin.Context) {
	items, err := h.svc.ListRoles(c.Request.Context(), actorFrom(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) adminListPermissions(c *gin.Context) {
	items, err := h.svc.ListPermissions(c.Request.Context(), actorFrom(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) adminReplaceRolePerms(c *gin.Context) {
	roleID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(c, apperr.Invalid(map[string]string{"id": "不是合法的角色 ID"}))
		return
	}
	var req replacePermsReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	err = h.svc.ReplaceRolePermissions(c.Request.Context(), actorFrom(c), ReplaceRolePermsInput{
		RoleID: roleID, PermKeys: req.PermKeys, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) adminSetUserRole(c *gin.Context) {
	var req setRoleReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	err := h.svc.SetUserRole(c.Request.Context(), actorFrom(c), SetUserRoleInput{
		UserPublicID: c.Param("id"), RoleID: req.RoleID, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) adminGrantPerm(c *gin.Context) {
	var req grantPermReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	expires, err := parseTimePtr(req.ExpiresAt)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	err = h.svc.GrantPermission(c.Request.Context(), actorFrom(c), GrantPermInput{
		UserPublicID: c.Param("id"), PermKey: c.Param("perm"),
		Reason: req.Reason, ExpiresAt: expires, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nil)
}

func (h *Handler) adminRevokePerm(c *gin.Context) {
	err := h.svc.RevokePermission(c.Request.Context(), actorFrom(c),
		c.Param("id"), c.Param("perm"), ClientIP(c))
	if err != nil {
		if err == errPermGrantNotFound {
			httpx.Fail(c, apperr.ErrNotFound)
			return
		}
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) adminBan(c *gin.Context) {
	var req banReq
	if err := httpx.Bind(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.BanUser(c.Request.Context(), actorFrom(c), BanInput{
		UserPublicID: c.Param("id"), Action: req.Action, Reason: req.Reason, IP: ClientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) adminRevokeSessions(c *gin.Context) {
	out, err := h.svc.RevokeUserSessions(c.Request.Context(), actorFrom(c), c.Param("id"), ClientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) adminAuditList(c *gin.Context) {
	var req auditQueryReq
	if err := httpx.BindQuery(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := req.toQuery()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items, next, err := h.svc.ListAuditLogs(c.Request.Context(), actorFrom(c), q)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, items, next)
}

// adminAuditExport 是**唯一直接写 c.Writer 的端点**（设计 §13.2 第 4 条）：
// CSV 要边写边发，不能先攒成一个大字符串再包装成 JSON。别顺手把它「统一」掉。
func (h *Handler) adminAuditExport(c *gin.Context) {
	if f := c.Query("format"); f != "" && f != "csv" {
		httpx.Fail(c, apperr.Invalid(map[string]string{"format": "只支持 csv"}))
		return
	}
	var req auditQueryReq
	if err := httpx.BindQuery(c, &req); err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := req.toQuery()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// 必须在写 body 之前定头：一旦开始写，状态码就发出去了。
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q",
		"audit-"+h.svc.clk.Now().UTC().Format("20060102-1504")+".csv"))
	if err := h.svc.ExportAuditCSV(c.Request.Context(), actorFrom(c), q, c.Writer); err != nil {
		// 已经写了 200 与部分 body，这里只能中断连接并把错误记进日志（httpx.Fail 会二次写状态码）。
		httpx.Logger(c).Error("auth: 导出审计失败", "err", err.Error())
		c.Abort()
		return
	}
}

var _ = http.StatusOK

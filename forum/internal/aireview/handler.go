package aireview

import (
	"context"
	"errors"
	"io"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Fail。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂载 AI 审核的四个 admin 端点（d7 §8）。权限点沿用 site.setting，**不新造权限点**。
//
// 调用方（app 层）：
//
//	aireview.NewHandler(m.AIReview, auth.FromGin).Register(v1, authSvc.RequireLogin, authSvc.Perm)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin func() gin.HandlerFunc, perm func(...string) gin.HandlerFunc) {
	admin := rg.Group("/admin", requireLogin())
	admin.GET("/ai/config", perm(authz.PermSiteSetting), h.getConfig)
	admin.PATCH("/ai/config", perm(authz.PermSiteSetting), h.patchConfig)
	admin.POST("/ai/config/secret", perm(authz.PermSiteSetting), h.saveSecret)
	admin.POST("/ai/test", perm(authz.PermSiteSetting), h.test)
	// D33①：审核屏要显示的「真正发给模型的那一份」。dry-run，**一次外呼都不发**。
	// 体量配额不在路由上：BodyLimit 是外层先包先生效的形状，配额由 app 层的独立组给 16 MiB。
	admin.POST("/ai/payload", perm(authz.PermSiteSetting), h.payload)
}

// getConfig 的回执里**没有密钥字段**（d7 §8：密钥永不回显，只有 has_secret 与 secret_updated_at）。
func (h *Handler) getConfig(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg, err := h.svc.GetConfig(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, viewOf(cfg))
}

// patchConfig 只写传进来的字段；密钥**不在这个请求体里**（它走 /config/secret）。
func (h *Handler) patchConfig(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var in ConfigPatch
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	ctx := c.Request.Context()
	if err := h.svc.UpdateConfig(ctx, in.toInput()); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg, err := h.svc.GetConfig(ctx)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, viewOf(cfg))
}

// saveSecret 是密钥的唯一写入口。**只写不回显**：回执里连 has_secret 之外什么都不给。
func (h *Handler) saveSecret(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var in SecretInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	if in.APIKey == "" {
		httpx.Fail(c, apperr.Invalid(map[string]string{"api_key": "不能为空"}))
		return
	}
	if err := h.svc.SaveKey(c.Request.Context(), in.APIKey); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"has_secret": true})
}

// test 是「测试连通」：真发一次请求，回耗时 / 实际模型名 / 原始 verdict（d7 §8）。
// body 可以不带（老调用方）：带了 probe 就发那一段，没带就发默认样例（D33②③，**不落库**）。
// 带了 topic_id 则换一条路：真发一次**这条帖子**（含配图）的 payload，回执里带「判了几张图」。
func (h *Handler) test(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	// D34：multipart 是样例可带图的另一种形态（probe 文本 + 0..4 张 file），与 JSON body 服务同一条
	// test 台。图片只在内存里走（probe.go），**旧 JSON 路径一字不改** —— 前端没带图时照旧发 JSON。
	if c.ContentType() == "multipart/form-data" {
		probe, files, err := readProbeMultipart(c.Request)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		out, err := h.svc.TestSample(c.Request.Context(), probe, files)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out)
		return
	}
	var in payloadReq
	// 空 body 是合法的：这条端点从前就没有入参，老前端不发 body 也得照样能测。
	// 只放过**一个字节都没有**这一种（`EOF`），其余解析失败照常报出去。
	if err := httpx.Bind(c, &in); err != nil && !errors.Is(err, io.EOF) {
		httpx.Fail(c, err)
		return
	}
	// 带 topic_id / topic_public_id = **拿一条真帖子试跑一次**（D33③ 的当场验证：预览里看到图 →
	// 跑 → 回执里看到结论与「判了几张图」）。组装与真判定同源（含图），外呼也真发，但一个字都不落库。
	id, err := h.topicID(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if id > 0 {
		out, err := h.svc.TestTopic(c.Request.Context(), id)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out)
		return
	}
	out, err := h.svc.Test(c.Request.Context(), in.Probe)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// payload 是 dry-run 的组装口（D33①）：按当前配置 + 给定正文，回「将要发送的 system + user 全文」。
// 两种来源共用这一条：topic_id > 0 读真帖子（sqlSubject，与真判定同一条 SQL），否则回连通测试的样例。
// **只读**：不改配置、不写 last_error、不外呼 —— 它唯一的作用是让界面说的和真发的是同一份。
func (h *Handler) payload(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	// D34：样例带图的干跑（与 test 的 multipart 分支同一条读取口）。只组装、不外呼；
	// topic 试跑仍只走 JSON（topic_public_id 不在 multipart 字段里）。
	if c.ContentType() == "multipart/form-data" {
		probe, files, err := readProbeMultipart(c.Request)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		out, err := h.svc.PreviewSample(c.Request.Context(), probe, files)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out)
		return
	}
	var in payloadReq
	// 与 test 同一条规矩：一个字节都没有 = 「只想看样例」那一路，不是错误。
	// 这条分支不能省：preview_test.go 的 TestPayloadEndpointIsWiredAndReadsTheRealTopic 拿空 body 打这条端点，
	// 少了它就是 500（Bind 把 EOF 当解析失败报上来）。
	if err := httpx.Bind(c, &in); err != nil && !errors.Is(err, io.EOF) {
		httpx.Fail(c, err)
		return
	}
	ctx := c.Request.Context()
	id, err := h.topicID(ctx, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var out *PayloadView
	if id > 0 {
		out, err = h.svc.Preview(ctx, PayloadInput{TopicID: id, Trigger: in.Trigger})
	} else {
		out, err = h.svc.PreviewProbe(ctx, in.Probe)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// topicID 把请求里的两种寻址收敛成一个内部 id（0 = 走 probe 那一路）。
// 管理端点收的是**对外 id**（uuid），判定链路用 bigint —— 换算只此一处。
func (h *Handler) topicID(ctx context.Context, in payloadReq) (int64, error) {
	if in.TopicID > 0 {
		return in.TopicID, nil
	}
	if in.TopicPublicID == "" {
		return 0, nil
	}
	return h.svc.TopicIDByPublicID(ctx, in.TopicPublicID)
}

// require 是登录端点的取 actor：拿不到就是 401。
func (h *Handler) require(c *gin.Context) (*authz.Actor, error) {
	actor, ok := h.actor(c)
	if !ok || actor == nil {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}

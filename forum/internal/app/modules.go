package app

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/aireview"
	"forum/internal/auth"
	"forum/internal/config"
	"forum/internal/forum"
	forumpgsql "forum/internal/forum/pgsql"
	"forum/internal/mail"
	"forum/internal/media"
	"forum/internal/message"
	messagepgsql "forum/internal/message/pgsql"
	"forum/internal/notify"
	notifypgsql "forum/internal/notify/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/captcha"
	"forum/internal/platform/httpx"
	"forum/internal/platform/image/localstore"
	searchpgsql "forum/internal/platform/search/pgsql"
	"forum/internal/release"
	"forum/internal/report"
	"forum/internal/reward"
	"forum/internal/site"
	"forum/internal/title"
	"forum/internal/user"
)

// minFreeBytes 是图片落盘前的磁盘余量闸门（localstore.Put 检查它）。
const minFreeBytes = 512 << 20

// Modules 是各域 Service 与它们之间适配器的组装结果。
//
// 它是**整个进程里唯一认识所有域的地方**（上线设计 §2 P1 决策 1/2）：http.go 只拿它挂路由，
// 各域 deps.go 的小接口在这里被适配器接上，业务模块之间不互相 import。
type Modules struct {
	Auth    *auth.Service
	User    *user.Service
	Forum   *forum.Service
	Media   *media.Service
	Release *release.Service
	Reward  *reward.Service
	Notify  *notify.Service
	Message *message.Service
	Title   *title.Service
	Site    *site.Service
	Mail    *mail.Service
	Report  *report.Service
	// AIReview 是 AI 审核域（d7）：它同时是 report 的 ReviewTrigger 实现（举报到阈值 → ai:review）。
	AIReview *aireview.Service
	// Captcha 是图形验证码的出题器（platform，不是业务域）：auth 消费它的结论。
	Captcha *captcha.Service

	in    *Infra
	audit *audit.Writer
	// fstore 是 forum 的 SQL 落点：举报的目标解析与 search:index 都要按 id 读主题 / 楼层，
	// 那些 SQL 已经在 forum/pgsql 里，app 层不重写一份（开发必读 §1 第 8 条）。
	fstore *forumpgsql.Store
}

// newModules 按依赖顺序构造全部域。任何一步失败都返回错误：**启动即失败**，
// 不让进程带着半个装配跑起来（上线设计 §2 P1 决策 5）。
func newModules(ctx context.Context, cfg *config.Config, in *Infra) (*Modules, error) {
	m := &Modules{in: in}
	m.audit = audit.New(in.DB, in.Clock)
	m.fstore = forumpgsql.NewStore(in.DB)

	store, err := localstore.New(cfg.Image.Root, minFreeBytes)
	if err != nil {
		return nil, err
	}
	m.Media = media.NewService(media.Config{
		AvatarMax:    cfg.Image.AvatarMax,
		PostMax:      cfg.Image.PostMax,
		PaymentMax:   cfg.Image.PaymentMax,
		ServeLocally: cfg.Image.ServeLocally,
	}, in.DB, store, in.Clock, in.Log)

	// site 先于 mail：mail 每次投递读 site.name 与 mail.enabled（d6 §5.4）。
	m.Site = site.NewService(in.DB, cfg.Site.BaseURL, m.audit, in.Clock, in.Log)
	if err := m.Site.RegisterBaseDomain(ctx); err != nil {
		return nil, err
	}
	m.Mail = mail.NewService(in.DB,
		mail.Keys{KeyHex: cfg.Mail.KeyHex, OldKeysHex: cfg.Mail.OldKeyHex},
		in.Queue, m.Site, m.audit, in.Clock, in.Log)

	// user 的头像 URL 由 media 拼（U15：/img/<hash> 只有那一个拼接点）。
	m.User = user.NewService(in.DB, m.Media, in.Clock, user.Config{})

	// 图形验证码：出题器 + 三种模式的判定（platform/captcha）。
	// mode=off 也照建（GET /api/v1/captcha 在任何模式下都要能出图 —— 注册页永远带这个字段）。
	m.Captcha, err = captcha.New(in.Cache, in.Clock)
	if err != nil {
		return nil, fmt.Errorf("装配: captcha: %w", err)
	}
	m.Auth, err = auth.NewService(cfg, in.DB, in.Clock, auth.Deps{
		Users: m.User, Mail: m.Mail, Mailer: m.Mail, Captcha: m.Captcha,
		Limiter: in.Limiter, Queue: in.Queue, Log: in.Log,
	})
	if err != nil {
		return nil, err
	}

	m.Forum = forum.NewService(in.DB, in.Clock, in.Counter, entQueue{in.Queue}, forum.Deps{
		// Render 是唯一的 Markdown 出口。Users 在本域没有调用点（SQL 里 JOIN 了 users），留 nil。
		Render: mdRenderer{}, Queue: entQueue{in.Queue},
		Counter: in.Counter, Limit: in.Limiter,
	})
	// release 的下载计数与 forum 的浏览量共用一个缓冲：pgcounter 一条语句写两张表。
	m.Release = release.NewService(in.DB, in.Counter, in.Clock, in.Log)
	m.Reward = reward.NewService(in.DB, entQueue{in.Queue}, rewardUsers{m}, m.Site,
		rewardAudit{m.audit}, in.Clock, in.Log)
	notifyDB := notifypgsql.New(in.DB)
	m.Notify = notify.NewService(in.DB, in.Clock, notifyDB, notify.NewNoticeSettings(notifyDB))
	m.Message = message.NewService(in.DB, in.Clock, messagepgsql.New(in.DB), msgUsers{m}, m.Forum)
	m.Title = title.NewService(in.DB, in.DB, in.Clock, titleAudit{m})

	// AI 审核域（d7）：库句柄是 pgx 原生池（这两张表不加 ent schema），密钥加解密与发信同一套。
	// crypter 从 mail 域拿 —— 主密钥只有一把，**不为 AI 再引一把**（d7 §2.1）。
	// 主密钥没配时不拒绝启动（与 mail 域「缺主密钥也照启动、只是发信不可用」的既定决定一致）：
	// AI 审核在真正要解密时会报「未配置」并转人工，不会让整站起不来。
	m.AIReview = aireview.New(in.Pool, nil, m.Mail.Crypter, entQueue{in.Queue}, m.Site, in.Clock, in.Log)
	m.Report = report.NewService(in.DB, reportTargets{m}, reportUsers{m}, m.Site, m.AIReview,
		m.audit, in.Clock, in.Log)
	return m, nil
}

// ── 中间件工厂：域只认这些形状，不认识 auth 包（各自 Register 的入参就是它们） ──

// requireLogin 给「要一个中间件值」的域（forum / notify / message / title / auth 自己）。
func (m *Modules) requireLogin() gin.HandlerFunc { return m.Auth.RequireLogin() }

// requireLoginFn 给「要一个工厂」的域：media / release / reward 的 Register 收的是
// func(...string) gin.HandlerFunc，并在内部用 requireLogin() 零参数调用它。
func (m *Modules) requireLoginFn(...string) gin.HandlerFunc { return m.Auth.RequireLogin() }

// perm 是全局权限点中间件（默认 AND）。
func (m *Modules) perm(perms ...string) gin.HandlerFunc { return m.Auth.Perm(perms...) }

// perm1 给 forum：它的 Register 收 perm func(string) gin.HandlerFunc。
func (m *Modules) perm1(perm string) gin.HandlerFunc { return m.Auth.Perm(perm) }

// endpointLimits 是「按端点限流」的额度表（v2 §9.4）。键由域在 Register 里给，
// 额度在这里定：域不 import 平台限流包，所以额度表只有这一份。
var endpointLimits = map[string]struct {
	limit  int
	window time.Duration
}{
	"report:create": {10, time.Hour}, // d6 §5.6 第 5 条
	"reward:create": {10, time.Hour}, // d6 §4 第 8 条
	"reward:verify": {60, time.Hour}, // 核验是管理动作，额度放宽
	// 申诉的两条免登录路（C4）：闸门是图形验证码（见 appeal 域的 checkCaptcha），
	// 限流是第二道 —— 它挡的是「同一来源反复提交」。
	//
	// 取 20/小时的理由：一个 IP 背后常常是一整个 NAT（学校 / 公司 / 小区），
	// 而申诉天然是成批出现的（一次封禁事件里同一个网段的多个人同时来申诉）。
	// 20 对单个人远超需要（他自己还有 24 小时 3 条的额度），对批量也只挡住脚本。
	"appeal:create": {20, time.Hour},
	// 查进展的额度放宽到 60：正常用户会反复回来看结果，而这条路的真正防线是
	// 「单号 + 邮箱两条都对上」（单号本身不可枚举：AP-<id+2000> 里 id 是全局自增，
	// 猜中一条要同时猜中邮箱）。60 只挡暴力枚举。
	"appeal:lookup": {60, time.Hour},
}

// limitIP 是按来源 IP 计数的限流（免登录端点的唯一可用身份）。
//
// 与下面的 limit 分开：那个按登录用户计数、且要求路由挂了 requireLogin，
// 对免登录的两条路只会永远拒绝放行（actor.UserID == 0）。
func (m *Modules) limitIP(key string, next ...gin.HandlerFunc) gin.HandlerFunc {
	rate, ok := endpointLimits[key]
	if !ok {
		rate = defaultRate
		m.in.Log.Warn("装配: 限流键没上表，按兜底额度", "key", key, "limit", rate.limit)
	}
	return func(c *gin.Context) {
		k := key + ":ip:" + c.ClientIP()
		pass, retry, err := m.in.Limiter.Allow(c.Request.Context(), k, rate.limit, rate.window)
		if err != nil {
			// 限流后端不可用 = 拒绝放行（platform/kv 的约定），否则它是「一挂就没有限流」。
			m.in.Log.Error("装配: 限流后端不可用", "key", k, "err", err.Error())
			httpx.Fail(c, apperr.ErrRateLimited.WithMsg("限流服务不可用，请稍后再试"))
			return
		}
		if !pass {
			secs := int(retry.Seconds())
			if secs < 1 {
				secs = 1
			}
			httpx.Fail(c, apperr.ErrRateLimited.WithMsg("操作太频繁，请 "+strconv.Itoa(secs)+" 秒后再试"))
			return
		}
		// next 是这条路由自己的中间件链（与 appeal.chain 同义：逐段判 IsAborted）。
		for _, h := range next {
			h(c)
			if c.IsAborted() {
				return
			}
		}
	}
}

// defaultRate 是没上表的键的兜底：宁可慢一点，也不要「没配 = 不限流」。
var defaultRate = struct {
	limit  int
	window time.Duration
}{30, time.Hour}

// limit 是 reward / report 要的限流中间件工厂：键 + 当前用户 → 429。
// 判定与拒绝形状与 auth 的 allow 一致（同一个 RateLimiter，同一个错误码）。
func (m *Modules) limit(key string, h gin.HandlerFunc) gin.HandlerFunc {
	rate, ok := endpointLimits[key]
	if !ok {
		rate = defaultRate
		m.in.Log.Warn("装配: 限流键没上表，按兜底额度", "key", key, "limit", rate.limit)
	}
	return func(c *gin.Context) {
		actor, ok := auth.FromGin(c)
		if !ok || actor.UserID == 0 {
			// 路由挂了 requireLogin（域自己保证）；取不到身份是路由写错了，拒绝放行。
			httpx.Fail(c, apperr.ErrUnauthorized)
			return
		}
		k := key + ":user:" + strconv.FormatInt(actor.UserID, 10)
		pass, retry, err := m.in.Limiter.Allow(c.Request.Context(), k, rate.limit, rate.window)
		if err != nil {
			// 限流后端不可用 = 拒绝放行（platform/kv 的约定），否则它是「一挂就没有限流」。
			m.in.Log.Error("装配: 限流后端不可用", "key", k, "err", err.Error())
			httpx.Fail(c, apperr.ErrRateLimited.WithMsg("限流服务不可用，请稍后再试"))
			return
		}
		if !pass {
			secs := int(retry.Seconds())
			if secs < 1 {
				secs = 1
			}
			httpx.Fail(c, apperr.ErrRateLimited.WithMsg("操作太频繁，请 "+strconv.Itoa(secs)+" 秒后再试"))
			return
		}
		h(c)
	}
}

// searchIndex 是 platform/search 的 PostgreSQL 实现（search:index 任务写它）。
func (m *Modules) searchIndex() *searchpgsql.Searcher { return searchpgsql.New(m.in.DB) }

// titleUsers 给 title 的 handler：它自己要把 handle / public_id 换成内部 id。
func (m *Modules) titleUsers() title.UserLookup { return titleUsers{m} }

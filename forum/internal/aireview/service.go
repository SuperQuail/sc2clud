package aireview

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/ent"
	"forum/internal/platform/ai"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/queue"
	"forum/internal/report"
)

// 站点设置键（d7 §2.2）。读到就用站点设置，读不到用代码默认值。
const (
	settingEnabled    = "ai.review.enabled"
	settingDailyLimit = "ai.review.daily_limit_per_topic"

	defaultDailyLimit = 3
)

// defaultPrompt 是 ai_config.prompt / prompt_report 留空时的内置提示词（d7 §4 逐字）。
// 「宁可放过，不可错杀」那一段是刻意的：误杀正常帖子的代价远大于放过边缘内容。
const defaultPrompt = `你是中文社区（星际争霸战役作者社区）的内容审核员。判断下面这篇帖子是否适合公开发布。

拒绝（reject）—— 只在这些情况：
  · 广告、推广、拉群、卖号、引流到站外交易；
  · 辱骂、人身攻击、地域/民族歧视、色情、暴力威胁；
  · 违法违规内容；
  · 与本站主题完全无关的刷屏内容。

拿不准（review）—— 下列情况必须交人工，不要自己决定：
  · 你不确定是否违规；
  · 内容涉及争议话题、指控某个人、或涉及真实身份；
  · 正文为空、噪声、或明显是机器生成的乱码；
  · 任何你无法判断的情境。

其余一律通过（approve）。**宁可放过，不可错杀**——本站是创作者社区，误杀一篇正常帖子的代价远大于放过一篇边缘内容。

理由（reason）用中文，不超过 60 字，直接说原因，不要复述规则。
调用 submit_review 提交结论。`

// JudgeFunc 是外呼口（platform/ai.JudgeImages 的形状）：New 收到 nil 就用真的实现，用例注入假实现。
// images 为空切片 = 纯文本那一条（请求体与多模态上线之前逐字同形）。
type JudgeFunc func(ctx context.Context, cfg ai.Config, prompt, text string, images []ai.Attachment) (ai.Result, error)

// Settings 是站点设置的只读视图，由 app 注入 site.Service —— **别的模块读站点开关的唯一入口**：
// 本域不自己查 site_settings，那样会有第二份缓存与第二套默认值。
type Settings interface {
	SettingBool(ctx context.Context, key string) bool
	SettingInt(ctx context.Context, key string) int
}

// Logger 只要一个 Warn：审核失败要能在日志里看见（d7 §7 的失败率数据靠它 + ai_config.last_error）。
type Logger interface{ Warn(msg string, args ...any) }

// TxQueue 是事务内入队口，由 app 注入（entQueue 把 *ent.Tx 收窄成 queue.TxExecutor）。
// 举报到阈值时的 ai:review 与举报行**同一个事务**：事务回滚，任务也不存在（拍板 §5.4）。
type TxQueue interface {
	EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
}

// Service 是 AI 审核域（d7-ai-review.md）。
//
// **AI 是第一道审核，人是最后一道**：它不是独立业务线，而是审核队列的一个判定来源 ——
// 读写 forum 的主题状态，并把每一次判定记进 review_events。
type Service struct {
	pool    *pgxpool.Pool
	crypter Crypter
	q       TxQueue
	set     Settings
	clk     clock.Clock
	judge   JudgeFunc
	imgs    ImageReader // 配图字节的读口（media）；nil = 没接线，带图帖一律转人工（见 loadImages）
	log     Logger
}

// New 的签名就是接线契约（app/modules.go 的装配处）：库句柄是 pgx 原生池（ai_config 与
// review_events 不加 ent schema），密钥加解密与发信**同一套**（d7 §2.1），judge 传 nil 走真外呼。
func New(pool *pgxpool.Pool, judge JudgeFunc, imgs ImageReader, crypter Crypter, q TxQueue, set Settings, clk clock.Clock, log Logger) *Service {
	if judge == nil {
		judge = ai.JudgeImages
	}
	return &Service{pool: pool, imgs: imgs, crypter: crypter, q: q, set: set, clk: clk, judge: judge, log: log}
}

// ReviewTopic 是 d7 §6 的八步。ctx 来自任务，topicID 是**内部 id**（payload 里就是它）。
func (s *Service) ReviewTopic(ctx context.Context, topicID int64, trigger string) error {
	// 1) 配置与开关：ai_config.enabled 与 site_settings 的 ai.review.enabled 是「且」。
	cfg, err := s.GetConfig(ctx)
	if err != nil {
		return err
	}
	if !cfg.Enabled || !s.set.SettingBool(ctx, settingEnabled) {
		return nil
	}
	key, err := s.LoadKey(ctx)
	if err != nil {
		// 没配密钥不是错误：主题留在 pending，人工队列里能看到（d7 §10 验收 1）。
		s.markError(ctx, err.Error())
		return nil
	}

	// 2) 取主题：标题 + 1 楼 Markdown 源 + 可见性/判定来源 + 未处理举报数（sqlSubject 不含作者）。
	var (
		id          int64
		publicID    string
		title       string
		body        string
		visibility  string
		source      *string
		openReports int
		images      int
	)
	err = s.pool.QueryRow(ctx, sqlSubject, topicID).Scan(&id, &publicID, &title, &body, &visibility, &source, &openReports, &images)
	if err != nil {
		return nil // 主题没了：没什么可审的，不是错误
	}
	if visibility == "deleted" || (source != nil && *source == "manual") {
		return nil // **AI 绝不覆盖人工判定**，也不碰已删主题（d7 §1/§6）
	}

	// 3) 单帖当日调用上限（d7 §2.2）：超限就留在 pending 交人工。
	limit := s.set.SettingInt(ctx, settingDailyLimit)
	if limit <= 0 {
		limit = defaultDailyLimit // 键未声明时 site 返回 0：那是「没配」，不是「不许调」
	}
	var today int
	if err := s.pool.QueryRow(ctx, sqlCallsToday, topicID).Scan(&today); err != nil {
		return err
	}
	if today >= limit {
		return nil
	}

	// 4) 组装：走 preview.go 那一个组装处（审核屏的预览读的就是它）——**不截断正文**（d7 §2.4），
	// **不放作者信息**（d7 §2.4/§11：昵称/邮箱/IP 与审核无关）。
	prompt := assemblePrompt(cfg, trigger == "report")
	text := userText(reportPrefix(openReports, trigger), title, body)

	// 4b) 配图（D33③）：与正文同一条取数口（loadImages），上限/顺序/截断都在那里。
	imgs, err := s.loadImages(ctx, topicID)
	if err != nil {
		return err
	}
	if imgs.ReadFailed {
		// 读图失败 → **转人工**：不是违规，也不让整帖判定失败（不返回错误、不改状态、不写事件）。
		// 记 last_error 让运维看得见（文件丢了是运维事故）。
		s.markError(ctx, "配图读不到，转人工："+failingNote(imgs))
		s.log.Warn("AI 审核：配图读不到，转人工", "topic_id", topicID)
		return nil
	}

	// 5) 外呼（超时在 ai.Config 里；有图时下限 60s，见 images.go）。
	res, err := s.judge(ctx, s.aiConfig(cfg, key, len(imgs.Attachments) > 0), prompt, text, imgs.Attachments)
	if err != nil {
		// 调用失败：记 last_error，**不改状态**（留在 pending 交人工）；返回错误让队列退避重试。
		s.markError(ctx, err.Error())
		return err
	}
	s.markOK(ctx)

	// 6) 判定 -> 状态（d7 §1）。拿不准时两列都不写（见 outcome 的注释）。
	state, note := outcome(res.Verdict, res.Reason)

	// 7) 单事务：写 review_events + 改 topics。复审判违规额外 hidden + 审计 ——
	// visibility 只到 hidden，**deleted 只有人能按**（d7 §1 硬规则 1）。
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 省略 categories 是 schema 允许的（它只 required verdict/reason），而这一列是 NOT NULL：
	// nil 走 pgx 会当 SQL NULL 发出去，撞 23502 —— 判定落不了库、任务反复重试。
	// 判定的**唯一写库口**在这里，所以兜底也放这里（外呼口是注入点，不能指望每个实现都记得）。
	if res.Categories == nil {
		res.Categories = []string{}
	}
	if _, err := tx.Exec(ctx, sqlInsertEvent, topicID, trigger, string(res.Verdict),
		trimRunes(res.Reason, 200), res.Categories, res.Model, res.LatencyMS,
		imgs.sent(), imgs.skipped()); err != nil {
		return err
	}
	hidden := trigger == "report" && res.Verdict == ai.Reject
	if _, err := tx.Exec(ctx, sqlUpdateTopic, topicID, state, note, hidden); err != nil {
		return err
	}
	if hidden {
		detail, _ := json.Marshal(map[string]any{
			"before":       map[string]string{"visibility": visibility},
			"after":        map[string]string{"visibility": "hidden"},
			"open_reports": openReports,
		})
		// audit_logs.target_id 是 varchar：按既有约定存**对外 id**，不存自增 id（0003_authz 第 99 行）。
		if _, err := tx.Exec(ctx, sqlInsertAudit, publicID, string(detail)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Test 是 d7 §8 的「测试连通」：真发一次请求，用固定短文本（**不消耗任何用户内容**）。
// 回执是 TestView 的字段形状，**不含密钥、不含请求体**。
// probe 是要发的那段样例（空串 = DefaultProbeSample）。**不落库**：样例是排查用的输入，
// 不是配置 —— 把它写进 ai_config 要加列 + 迁移，而它下一次排查就该被换掉（界面上也标着「临时覆盖」）。
func (s *Service) Test(ctx context.Context, probe string) (*TestView, error) {
	cfg, err := s.GetConfig(ctx)
	if err != nil {
		return nil, err
	}
	key, err := s.LoadKey(ctx)
	if err != nil {
		return nil, err
	}
	res, err := s.judge(ctx, s.aiConfig(cfg, key, false), assemblePrompt(cfg, false), probeText(probe), nil)
	if err != nil {
		s.markError(ctx, err.Error())
		return nil, err
	}
	s.markOK(ctx)
	return viewOfTest(res), nil
}

// TestTopic 是「拿一条真帖子试跑一次」（D33③ 的当场验证）：组装与真判定**同一条**
// （assemblePrompt + userText + loadImages，含图），外呼也真发，但**一个字都不落库** ——
// topics 的状态、review_events、配额计数全都不动。它是管理端的排查工具，不是审核动作。
//
// 与 ReviewTopic 的差别只有两处，都是有意的：① 不做「已删/已人工判」的短路（管理员就是要看它会怎么判）；
// ② 不写状态机。费用上它和一次真判定一样贵，所以它挂在 site.setting 权限点后面，且没有自动触发。
func (s *Service) TestTopic(ctx context.Context, topicID int64) (*TestView, error) {
	cfg, err := s.GetConfig(ctx)
	if err != nil {
		return nil, err
	}
	key, err := s.LoadKey(ctx)
	if err != nil {
		return nil, err
	}
	var (
		id          int64
		publicID    string
		title       string
		body        *string
		visibility  string
		source      *string
		openReports int
		attached    int // 图集里的引用行数（loadImages 才是取字节的那一步）
	)
	err = s.pool.QueryRow(ctx, sqlSubject, topicID).Scan(
		&id, &publicID, &title, &body, &visibility, &source, &openReports, &attached)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	imgs, err := s.loadImages(ctx, topicID)
	if err != nil {
		return nil, err
	}
	if imgs.ReadFailed {
		return nil, apperr.New("ai.image_unreadable", http.StatusBadGateway, "配图读不到，这条帖子的试跑结果不可信："+failingNote(imgs))
	}
	res, err := s.judge(ctx, s.aiConfig(cfg, key, len(imgs.Attachments) > 0),
		assemblePrompt(cfg, false), userText("", title, deref(body)), imgs.Attachments)
	if err != nil {
		s.markError(ctx, err.Error())
		return nil, err
	}
	s.markOK(ctx)
	out := viewOfTest(res)
	out.TopicID, out.Images = topicID, imageViews(imgs)
	out.ImageCount, out.ImageSkipped = imgs.sent(), imgs.skipped()
	return out, nil
}

// viewOfTest 是回执的唯一组装处（探针与带帖试跑共用）：字段形状 = dto.go 的 TestView。
func viewOfTest(res ai.Result) *TestView {
	return &TestView{
		Verdict: string(res.Verdict), Reason: res.Reason, Categories: res.Categories,
		Model: res.Model, LatencyMS: res.LatencyMS, Raw: res.Raw, Images: []PayloadImage{},
	}
}

// TriggerReportReview 是举报域的 ReviewTrigger（d7 §1/§7）：举报到阈值 → 复核。
// 它与举报行**同一个事务**（拍板 §5.4），所以入队走 tx，不走池。
func (s *Service) TriggerReportReview(ctx context.Context, tx *ent.Tx, in report.ReportReviewInput) error {
	if in.TopicID <= 0 {
		return nil
	}
	// 到第二阈值：**不再调 AI**，直接转人工（防举报风暴打爆额度）。条件写在 SQL 里：
	// 只在 review_source IS NULL 时落 manual，绝不覆盖既有判定。
	if in.Human {
		_, err := tx.ExecContext(ctx, sqlMarkManual, in.TopicID)
		return err
	}
	// 第一阈值：入队一次复审。轮次 = 已发生的 report 类事件数，同一轮的多次举报只入队一条
	//（unique_key 只在 pending/running 里去重，下一轮算出的轮次不同，所以不会被上一轮吃掉）。
	rows, err := tx.QueryContext(ctx, sqlCountReportRounds, in.TopicID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var round int
	if rows.Next() {
		if err := rows.Scan(&round); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return s.q.EnqueueTx(ctx, tx, queue.Task{
		Type:      queue.TypeAIReview,
		Payload:   json.RawMessage(payloadJSON(in.TopicID, "report")),
		UniqueKey: "review:report:" + itoa64(in.TopicID) + ":" + itoa(round),
		Priority:  priorityReview,
		MaxRetry:  maxRetryReview,
		RunAt:     s.clk.Now(),
	})
}

// aiConfig 把库里的配置翻成外呼参数（外呼口只认这一个形状）。
// withImages = 这次要发图：多图更慢，所以超时**只升不降**地抬到 imageTimeoutFloor
// （配置比它大就照配置；60s 是 ai_config.timeout_ms 的 CHECK 上限，抬不过去）。
// 超时仍然是可重试失败 —— 绝不因为「图多来不及」就把一篇帖子判成违规。
func (s *Service) aiConfig(cfg *Config, key string, withImages bool) ai.Config {
	timeout := time.Duration(cfg.TimeoutMS) * time.Millisecond
	if withImages && timeout < imageTimeoutFloor {
		timeout = imageTimeoutFloor
	}
	return ai.Config{
		BaseURL: cfg.BaseURL, Model: cfg.Model, APIKey: key,
		Thinking: cfg.Thinking, StrictMode: cfg.StrictMode,
		MaxOutputTokens: cfg.MaxOutputTokens,
		Timeout:         timeout,
	}
}

// failingNote 取第一张读不到的图上的那句话（markError 只要一句可读的原因）。
func failingNote(p *imagePayload) string {
	for _, f := range p.Facts {
		if !f.Sent && strings.HasPrefix(f.Note, "读不到：") {
			return f.Note
		}
	}
	return "有配图读不到"
}

// outcome 把三态判定翻成 topics 的两列。**review（拿不准）返回 nil**：sql.go 的 sqlUpdateTopic
// 用「$2 IS NULL」表达整段不动，于是拿不准不会覆盖上一轮/人工填的批注与来源 ——
// fail-open 到人工，不是放行（d7 §3.5）。
func outcome(v ai.Verdict, reason string) (state, note *string) {
	if v == ai.Review {
		return nil, nil
	}
	st := "approved"
	if v == ai.Reject {
		st = "rejected"
	}
	n := "AI 审核：" + trimRunes(reason, 200)
	return &st, &n
}

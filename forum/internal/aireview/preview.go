package aireview

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"forum/internal/platform/ai"
	"forum/internal/platform/apperr"
)

// 「真正发给模型的那一份」只有**一个**组装处：这个文件。
//
// 为什么单独成文件：组装过去散在 ReviewTopic（真判定）与 Test（连通测试）两处各拼一份字符串，
// 而审核屏要显示的正是这两段 —— 前端自己再拼一份就是**第二份真源**，两边一旦漂移
// （少一个「正文：」、多一个换行、举报前缀的计数不同），界面上的预览就是一句好听的假话。
// 现在真发的那条路与预览那条路走的是同一组函数（service.go 的 ReviewTopic / Test，
// 以及 preview_test.go 的 TestPreviewMatchesWhatIsActuallySent —— 拿假外呼收到的东西逐字比）。
//
// 铁律（d7 §2.4/§11，被 preview_test.go 钉住）：正文**不截断**、作者信息**一个字段都不放**。
// 界面上那句「已截断」只可能来自 review_queue 的 20000 字上限提示，不来自这里。

// DefaultProbeSample 是连通测试的默认样例（d7 §8：不消耗任何用户内容）。
// 界面把它显示出来、允许临时改一次再测；**不落库**（见 Service.Test 的入参注释）。
const DefaultProbeSample = "标题：连通性测试\n\n正文：这是一次连接测试，用来确认密钥与地址可用。"

// ToolName 是判定用的工具名（platform/ai 的 FunctionDefinitionParam.Name）。
// 放在这里是为了让预览能把「模型被要求调用哪个工具」也摊开，而不是只给两段文本。
const ToolName = "submit_review"

// PayloadInput 是预览的入参。**只认主题 id**：正文由服务端按 sqlSubject 现读，
// 客户端塞不进一份「和真发的不一样」的正文（那正是「同源」要防的事）。
type PayloadInput struct {
	TopicID int64
	// create（空 = create）| report | edit：只有 report 会换提示词与前缀；
	// **判哪一版不由这个字段决定**，而是「这条帖有没有待审槽」（与审核屏 draft 页签同源）。
	Trigger string
}

// Payload 是「下一次真调用会发出去的东西」。
type Payload struct {
	Source      string // probe | topic
	TopicID     int64
	Title       string
	Trigger     string
	OpenReports int

	System string
	// Prefix 是举报复核那一档写在前面的那一行（不是举报触发则为空）。
	// 单列出来是为了让界面能把「这一段不是作者写的」标出来 —— 把它混进 body 里，
	// 审核员会以为作者自己在正文里写了「该帖已被 3 人举报」。
	Prefix string
	// 真调用发的是 system + 一段 user 文本；这里把那段文本拆成**拼得回原文**的三段，
	// 界面才敢把「这一段是标题、这一段是正文」标出来（下面的 userText 是唯一拼接口）。
	UserTitle string
	UserBody  string
	UserText  string // probe 专用：连通测试发的就是样例本身，不分段

	HasImageMarkdown     bool
	ImageAttachmentCount int
	// Images 是这次要附上去的图（含每一张的下场）。nil = 还没取（probe 那一路没有图）。
	Images *imagePayload

	Model           string
	MaxOutputTokens int
	StrictMode      bool
	ToolName        string
	Categories      []string
}

// assemblePrompt 是「实际会用的那段提示词」的唯一选择处：配置留空用内置默认值（d7 §4），
// 举报复核那一档优先用 prompt_report（留空则与新建帖同一段）。
func assemblePrompt(cfg *Config, report bool) string {
	prompt := strings.TrimSpace(cfg.Prompt)
	if prompt == "" {
		prompt = defaultPrompt
	}
	if report {
		if p := strings.TrimSpace(cfg.PromptReport); p != "" {
			prompt = p
		}
	}
	return prompt
}

// systemPrompt 是上面那个选择器的**带配置版本**（预览要把 model / 上限一起给出去，
// 不该为了拿配置再把 ai_config 读第二遍）。
func (s *Service) systemPrompt(ctx context.Context, report bool) (string, *Config, error) {
	cfg, err := s.GetConfig(ctx)
	if err != nil {
		return "", nil, err
	}
	return assemblePrompt(cfg, report), cfg, nil
}

// probeText 是连通测试实际会发的那一段：传了就用传的，没传用默认样例。
// 两者都**不落库** —— 样例是排查用的输入，不是配置（见 Service.Test 的注释）。
func probeText(override string) string {
	if strings.TrimSpace(override) == "" {
		return DefaultProbeSample
	}
	return override
}

// reportPrefix 是举报复核那一档加在最前面的那行（ReviewTopic 的 trigger=report 分支逐字）。
func reportPrefix(openReports int, trigger string) string {
	if trigger != "report" {
		return ""
	}
	return "【举报复核】该帖已被 " + itoa(openReports) + " 人举报，重点看是否违规。\n"
}

// userText 是**发出去的 user 那一段**的唯一拼接口（prefix 为空时与从前逐字一致）。
func userText(prefix, title, body string) string {
	return prefix + "标题：" + title + "\n\n正文：\n" + body
}

// hasImageMarkdown 认的是正文里有没有图片 Markdown 字面量（感叹号 + 方括号 + 圆括号）——
// 图片在 payload 里**唯一的**可见痕迹。只是给界面一句实话用的，不参与任何判定。
func hasImageMarkdown(body string) bool {
	return strings.Contains(body, "![") && strings.Contains(body, "](")
}

// Preview 是「按当前配置 + 给定的这篇主题，组装出将要发送的 payload」——dry-run，**一次外呼都不发**。
func (s *Service) Preview(ctx context.Context, in PayloadInput) (*PayloadView, error) {
	trigger := in.Trigger
	if trigger == "" {
		trigger = "create"
	}
	prompt, cfg, err := s.systemPrompt(ctx, trigger == "report")
	if err != nil {
		return nil, err
	}

	// 主题这一路照抄 ReviewTopic 第 2 步的取数：同一张表、同一条 SQL。
	var (
		id          int64
		publicID    string
		title       string
		body        *string
		visibility  string
		source      *string
		openReports int
		images      int
	)
	// 预览显示「将要被审的那一版」：有待审槽就是它（与审核队列的 draft 页签一致）。
	// 真判定按 trigger 各判各的（见 ReviewTopic），预览只有这一档 —— 它显示的就是草稿页签里那份。
	pending, err := s.hasPending(ctx, in.TopicID)
	if err != nil {
		return nil, err
	}
	err = s.pool.QueryRow(ctx, sqlSubject, in.TopicID, pending).Scan(
		&id, &publicID, &title, &body, &visibility, &source, &openReports, &images)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.ErrNotFound // 主题没了：没什么可组装的，404 而不是 500
	}
	if err != nil {
		return nil, err
	}

	// 配图：**与真判定同一条取数口**（loadImages）。预览因此会做与真发一样的事 ——
	// 包括按上限截断、包括发现"这张读不到"（那正是要让人看见的：它会让这次审核转人工）。
	imgs, err := s.loadImages(ctx, id)
	if err != nil {
		return nil, err
	}

	return previewView(&Payload{
		Source: "topic", TopicID: id, Title: title, Trigger: trigger, OpenReports: openReports,
		System: prompt, Prefix: reportPrefix(openReports, trigger),
		UserTitle: "标题：" + title, UserBody: "正文：\n" + deref(body),

		HasImageMarkdown:     hasImageMarkdown(deref(body)),
		ImageAttachmentCount: images,
		Images:               imgs,
		Model:                cfg.Model, MaxOutputTokens: cfg.MaxOutputTokens, StrictMode: cfg.StrictMode,
		ToolName: ToolName, Categories: ai.Categories,
	}), nil
}

// PreviewProbe 是连通测试那一路：system = 将要用的提示词，user = 样例（可被这一次的编辑覆盖）。
func (s *Service) PreviewProbe(ctx context.Context, probe string) (*PayloadView, error) {
	prompt, cfg, err := s.systemPrompt(ctx, false)
	if err != nil {
		return nil, err
	}
	return previewView(&Payload{
		Source: "probe", UserText: probeText(probe), System: prompt,
		Model: cfg.Model, MaxOutputTokens: cfg.MaxOutputTokens, StrictMode: cfg.StrictMode,
		ToolName: ToolName, Categories: ai.Categories,
	}), nil
}

// PreviewSample 是样例带图的干跑（D34）：与 TestSample 同一条 probeImages 记账（含上限截断），
// 但**一次都不外呼、不写 last_error** —— 它唯一的作用是让界面说的和真发的是同一份。
// image_attachment_count 在这一路 = 这次 multipart 上传了几张（没有「图集」可言）。
func (s *Service) PreviewSample(ctx context.Context, probe string, files []ProbeImage) (*PayloadView, error) {
	prompt, cfg, err := s.systemPrompt(ctx, false)
	if err != nil {
		return nil, err
	}
	return previewView(&Payload{
		Source: "probe", UserText: probeText(probe), System: prompt,
		HasImageMarkdown: false, ImageAttachmentCount: len(files), Images: probeImages(files),
		Model: cfg.Model, MaxOutputTokens: cfg.MaxOutputTokens, StrictMode: cfg.StrictMode,
		ToolName: ToolName, Categories: ai.Categories,
	}), nil
}

// previewView 把内部 Payload 翻成线格式。**只有这一个出口**，两个来源（probe / topic）走同一条路。
func previewView(p *Payload) *PayloadView {
	out := &PayloadView{
		Source: p.Source, TopicID: p.TopicID, Title: p.Title, Trigger: p.Trigger,
		OpenReports: p.OpenReports,
		System:      p.System, UserPrefix: p.Prefix, UserTitle: p.UserTitle,
		UserBody: p.UserBody, UserText: p.UserText,
		HasImageMarkdown: p.HasImageMarkdown, ImageAttachmentCount: p.ImageAttachmentCount,
		Model: p.Model, MaxOutputTokens: p.MaxOutputTokens, StrictMode: p.StrictMode,
		ToolName: p.ToolName, Categories: p.Categories,
		Images: []PayloadImage{}, ImageLimit: maxImages, ImageMaxBytes: maxImageBytes,
	}
	if p.Images != nil {
		out.Images = imageViews(p.Images)
		out.ImageCount, out.ImageSkipped = p.Images.sent(), p.Images.skipped()
		out.ImageBytes = p.Images.Bytes
		out.ImageReadFailed = p.Images.ReadFailed
	}
	return out
}

// imageViews 是 imageFact -> 线格式的唯一翻译处（预览与带帖试跑共用）。
func imageViews(p *imagePayload) []PayloadImage {
	out := make([]PayloadImage, 0, len(p.Facts))
	for _, f := range p.Facts {
		out = append(out, PayloadImage{
			Position: f.Position, Floor: f.Floor, Hash: f.Hash,
			MIME: f.MIME, Bytes: f.Bytes, Sent: f.Sent, Note: f.Note,
		})
	}
	return out
}

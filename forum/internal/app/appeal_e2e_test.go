package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/appeal"
	"forum/internal/auth"
	"forum/internal/authz"
	"forum/internal/config"
	"forum/internal/mail"
	"forum/internal/platform/db"
	"forum/internal/testkit"
	"forum/migrations"
)

// C4 / C5 的端到端用例：**走真的那条路**（真库 + 全部迁移 + newModules + 真 HTTP 路由）。
//
// 这份文件回答交接单 §6 第 3 条：验收（未登录能提交、管理端能处理、被处理人能看到结果）
// 必须能在一个独立的人按契约证伪的方式下通过 —— 不是「service 单测过了」。
// 每一条断言都打在库里或响应体上，没有一条只断言「不是 500」。
//
// 请求体用 fmt.Sprintf 拼：本文件里出现的每一个字段名都是契约的一部分，
// 拼出来能看清哪个字段是哪个值（字段名一个字都不许改）。
func TestAppealEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("端到端用例要起真库，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)
	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}
	sink := &logSink{}
	in, m := newE2EModules(t, ctx, cfg, sink)

	// 图形验证码换成一个认得出答案的替身：真出题器画的是随机图，e2e 拿不到答案。
	// **换的是这一环的实现，不是这一环** —— 缺答案 / 错答案 / 未登录提交 C5 三条用例仍然会红。
	stub := testkit.NewCaptchaStub()
	appealCaptchaForTest = stub
	t.Cleanup(func() { appealCaptchaForTest = nil })

	// 前置：一个分区 + 一个超管（队列要 report.handle，超管短路；改判还要 post.review）。
	//
	// **名字带 nao 时间戳**：本包的多个用例共用一个库（e2e_test.go 也是它），而库**跨次运行保留** ——
	// 固定名字第二次跑就会撞 23505 / auth.handle_taken，那时红的不是被测代码，是测试自己的脏数据。
	// 后缀取纳秒的后 8 位：boards.slug 是 varchar(32)，整个纳秒串加前缀会超（第一次就是这么红的）。
	nao := time.Now().UnixNano() % 100000000
	board := fmt.Sprintf("appeal-general-%d", nao)
	rootHandle := fmt.Sprintf("appeal-root-%d", nao)
	if _, err := in.Pool.Exec(ctx, "INSERT INTO boards (slug, name, description) VALUES ($1, $2, $3)",
		board, "申诉用例分区", "申诉用例的分区"); err != nil {
		t.Fatalf("建分区: %v", err)
	}
	if err := m.Auth.CreateAdmin(ctx, auth.CreateAdminInput{
		Handle: rootHandle, Email: rootHandle + "@sc2clud.local", Nickname: rootHandle, Password: "root-password-1",
	}); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	// 前置：一个 provider=log 的发信账号 —— 注册要真的把激活码发出去（e2e_test.go 的主链路同一套前置）。
	// 没有它时注册直接 503 auth.mail_unavailable，本用例连 bob 都造不出来。
	root, err := m.User.BriefByHandle(ctx, rootHandle)
	if err != nil {
		t.Fatalf("读回超管: %v", err)
	}
	super := &authz.Actor{UserID: root.ID, Status: "active", Activated: true, IsSuper: true}
	if _, err := m.Mail.CreateAccount(ctx, super, mail.AccountInput{
		Name: fmt.Sprintf("appeal-log-%d", nao), Provider: "log", FromAddress: "noreply@sc2clud.local",
		Secret: json.RawMessage(`{"note":"log provider"}`),
	}); err != nil {
		t.Fatalf("建 log 发信账号: %v", err)
	}

	gin.SetMode(gin.TestMode)
	srv, err := newHTTPServer(cfg, in, m, BuildInfo{Version: "appeal-e2e", StartedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("newHTTPServer（路由注册在这里发生）: %v", err)
	}
	ts := httptest.NewServer(srv.Engine)
	defer ts.Close()
	bob := newAPIClient(t, ts.URL)

	// 前置：一个普通用户 bob（C5 要一个作者）。注册走真路径。
	bobName := fmt.Sprintf("appeal-bob-%d", nao)
	bobMail := bobName + "@example.com"
	registerUser(t, bob, sink, bobName, bobMail, "bob-password-1", "鲍勃")

	// ── 1. 未登录（游客）能提交申诉 ───────────────────────────────
	// 端点不存在时这条是 404；要求登录时是 401。两种都得让这条用例红。
	guest := newAPIClient(t, ts.URL) // 独立 Cookie 罐 = 真的未登录
	id, answer := stub.Issue()
	body := fmt.Sprintf(
		"{\"type\":\"ban\",\"username\":%q,\"email\":%q,\"title\":\"请复查 10-12 的封禁\",\"details\":\"我那天在上班。\",\"captcha_id\":%q,\"captcha\":%q}",
		bobName, bobMail, id, answer)
	raw := guest.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/appeals", body)
	no := jsonField(t, raw, "data", "no")
	if !strings.HasPrefix(no, "AP-") {
		t.Fatalf("单号形状不对：%q（期望 AP-<id+2000>）\n%s", no, raw)
	}
	// 真落库了（不是「202 但什么都没发生」）：自证那一列的判定也要对。
	var (
		verified bool
		userID   *int64
	)
	if err := in.Pool.QueryRow(ctx,
		"SELECT identity_verified, user_id FROM appeals WHERE no = $1::varchar", no).
		Scan(&verified, &userID); err != nil {
		t.Fatalf("库里没有这条申诉: %v", err)
	}
	if !verified || userID == nil {
		t.Fatalf("用户名 + 注册邮箱都对上了，identity_verified 应为 true 且绑上 user_id（got %v / %v）", verified, userID)
	}
	// 提交回执里有答复时限（设计稿的 done.eta；前端拿它渲染「预计 3 个工作日内答复」）。
	if eta := jsonField(t, raw, "data", "eta"); eta == "" {
		t.Fatalf("回执缺 eta:\n%s", raw)
	}

	// 答错验证码：**必须红**（这条证明验证码这一环还在，不是被替身绕过去了）。
	badID, _ := stub.Issue()
	status, rawBad := guest.do(http.MethodPost, "/api/v1/appeals", fmt.Sprintf(
		"{\"type\":\"other\",\"username\":\"someone\",\"email\":\"someone@example.com\",\"title\":\"t\",\"details\":\"d\",\"captcha_id\":%q,\"captcha\":\"ZZZZ\"}", badID))
	if status != http.StatusBadRequest || !strings.Contains(rawBad, "auth.captcha_wrong") {
		t.Fatalf("验证码答错应当 400 auth.captcha_wrong，实际 %d\n%s", status, rawBad)
	}
	// 没带验证码：同样 400（不静默放行）。
	status, rawMiss := guest.do(http.MethodPost, "/api/v1/appeals",
		"{\"type\":\"other\",\"username\":\"someone\",\"email\":\"someone@example.com\",\"title\":\"t\",\"details\":\"d\"}")
	if status != http.StatusBadRequest || !strings.Contains(rawMiss, "auth.captcha_required") {
		t.Fatalf("没带验证码应当 400 auth.captcha_required，实际 %d\n%s", status, rawMiss)
	}
	// 未登录提交 review_reject（C5 的事由）必须被明确拒绝，而不是收下一条没人认领的申诉。
	id2, ans2 := stub.Issue()
	status, rawType := guest.do(http.MethodPost, "/api/v1/appeals", fmt.Sprintf(
		"{\"type\":\"review_reject\",\"username\":%q,\"email\":%q,\"title\":\"t\",\"details\":\"d\",\"captcha_id\":%q,\"captcha\":%q}",
		bobName, bobMail, id2, ans2))
	if status != http.StatusBadRequest {
		t.Fatalf("免登录提交 review_reject 应当 400，实际 %d\n%s", status, rawType)
	}
	// 用户名空着也不行：免登录时它是自证的第一半（登录态才允许省略）。
	// **body 里刻意不写 username**（写一个 %q 进去测的就不是这件事了）。
	id3, ans3 := stub.Issue()
	status, _ = guest.do(http.MethodPost, "/api/v1/appeals", fmt.Sprintf(
		"{\"type\":\"other\",\"email\":%q,\"title\":\"t\",\"details\":\"d\",\"captcha_id\":%q,\"captcha\":%q}",
		bobMail, id3, ans3))
	if status != http.StatusBadRequest {
		t.Fatalf("免登录不带用户名应当 400，实际 %d", status)
	}

	// ── 2. 免登录查进展：单号 + 邮箱 ─────────────────────────────
	// 这是「被处理人能看到结果」在未登录那一侧的落点：被封的人登不进来，只有这两个凭据。
	lookup := guest.mustDo(http.StatusOK, http.MethodPost, "/api/v1/appeals/lookup",
		fmt.Sprintf("{\"no\":%q,\"email\":%q}", no, bobMail))
	if got := jsonField(t, lookup, "data", "status"); got != "pending" {
		t.Fatalf("刚提交的申诉状态应为 pending，实际 %q\n%s", got, lookup)
	}
	// 邮箱不对：**同一个 404**（区分「单号不存在」与「邮箱不对」等于给枚举单号的人一个预言机）。
	status, _ = guest.do(http.MethodPost, "/api/v1/appeals/lookup",
		fmt.Sprintf("{\"no\":%q,\"email\":\"someone-else@example.com\"}", no))
	if status != http.StatusNotFound {
		t.Fatalf("邮箱不匹配应当 404，实际 %d", status)
	}

	// ── 3. 管理端队列：能看、能处理、不能乱处理 ─────────────────────
	// 普通用户看不到队列（403）。这条挡住「队列忘了挂权限门」。
	if s, _ := bob.do(http.MethodGet, "/api/v1/admin/appeals", ""); s != http.StatusForbidden {
		t.Fatalf("普通用户看管理端队列应当 403，实际 %d", s)
	}
	admin := newAPIClient(t, ts.URL)
	admin.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/login",
		fmt.Sprintf("{\"login\":%q,\"password\":\"root-password-1\"}", rootHandle))
	queue := admin.mustDo(http.StatusOK, http.MethodGet, "/api/v1/admin/appeals?status=pending", "")
	if !strings.Contains(queue, no) {
		t.Fatalf("队列里没有刚提交的那条 %s:\n%s", no, queue)
	}
	// 答复必填：处理了却不给答复正是本域要消灭的形态（盲审二号）。
	if s, rawEmpty := admin.do(http.MethodPatch, "/api/v1/admin/appeals",
		fmt.Sprintf("{\"no\":%q,\"decision\":\"upheld\",\"response\":\"  \"}", no)); s != http.StatusBadRequest {
		t.Fatalf("空答复应当 400，实际 %d\n%s", s, rawEmpty)
	}
	decided := admin.mustDo(http.StatusOK, http.MethodPatch, "/api/v1/admin/appeals",
		fmt.Sprintf("{\"no\":%q,\"decision\":\"upheld\",\"response\":\"维持原处理：该回复在三个分区重复发布。\",\"close\":true}", no))
	if got := jsonField(t, decided, "data", "status"); got != "closed" {
		t.Fatalf("close=true 应当 status=closed，实际 %q\n%s", got, decided)
	}
	if got := jsonField(t, decided, "data", "decision"); got != "upheld" {
		t.Fatalf("decision 应为 upheld，实际 %q", got)
	}
	// 重放同一条：409（并发保证是 CAS 的那一条 UPDATE，不是「读一下再写」）。
	if s, _ := admin.do(http.MethodPatch, "/api/v1/admin/appeals",
		fmt.Sprintf("{\"no\":%q,\"decision\":\"upheld\",\"response\":\"再判一次\"}", no)); s != http.StatusConflict {
		t.Fatalf("重复处理应当 409，实际 %d", s)
	}
	// 处理过就不该再出现在 pending 队列里（否则队列越用越脏）。
	queue2 := admin.mustDo(http.StatusOK, http.MethodGet, "/api/v1/admin/appeals?status=pending", "")
	if strings.Contains(queue2, fmt.Sprintf("%q", no)) {
		t.Fatalf("已处理的申诉还在 pending 队列里:\n%s", queue2)
	}

	// ── 4. 被处理人能看到结果（两条路）────────────────────────────
	// ① 未登录：拿单号 + 邮箱回查，看得到答复正文。
	after := guest.mustDo(http.StatusOK, http.MethodPost, "/api/v1/appeals/lookup",
		fmt.Sprintf("{\"no\":%q,\"email\":%q}", no, bobMail))
	if !strings.Contains(after, "维持原处理") {
		t.Fatalf("答复正文没回到提交人手上:\n%s", after)
	}
	// ② 登录用户：这条申诉本来就是他提交的（用户名 + 邮箱对上了），「我的申诉」里要能看到它与答复。
	mine := bob.mustDo(http.StatusOK, http.MethodGet, "/api/v1/me/appeals", "")
	if !strings.Contains(mine, no) || !strings.Contains(mine, "维持原处理") {
		t.Fatalf("登录用户在自己的申诉列表里看不到 %s 或它的答复:\n%s", no, mine)
	}
	// 别人的申诉他看不到（列表按 user_id 过滤，不是「所有人的都摊开」）。
	others := newAPIClient(t, ts.URL)
	carol := fmt.Sprintf("appeal-carol-%d", nao)
	registerUser(t, others, sink, carol, carol+"@example.com", "carol-password-1", "卡罗尔")
	if got := others.mustDo(http.StatusOK, http.MethodGet, "/api/v1/me/appeals", ""); strings.Contains(got, no) {
		t.Fatalf("别人的申诉出现在了 carol 的列表里:\n%s", got)
	}

	// ── 5. C5：作者对审核结果申诉（登录 + 仅作者 + 幂等）──────────
	if _, err := in.Pool.Exec(ctx, "UPDATE users SET trusted = true WHERE username = $1", bobName); err != nil {
		t.Fatalf("标记 trusted: %v", err)
	}
	created := bob.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/topics",
		fmt.Sprintf("{\"board\":%q,\"kind\":\"discussion\",\"title\":\"被误判的帖子\",\"content_md\":\"正文\"}", board))
	topicID := jsonField(t, created, "data", "id")
	appealPath := "/api/v1/topics/" + topicID + "/review/appeal"

	// 先把它真的判成 rejected：C5 是「作者对**审核结果**申诉」，而刚发的帖子在 pending 态。
	// 判定走后台那条真路（POST /admin/topics/{id}/review，契约要 expected_updated_at —— 队列项的版本号）。
	version := jsonField(t, created, "data", "updated_at")
	admin.mustDo(http.StatusOK, http.MethodPost, "/api/v1/admin/topics/"+topicID+"/review",
		fmt.Sprintf("{\"action\":\"reject\",\"note\":\"疑似外链\",\"expected_updated_at\":%q}", version))

	// 未登录：401（端点只认作者）。
	if s, _ := guest.do(http.MethodPost, appealPath, "{\"reason\":\"误判\"}"); s != http.StatusUnauthorized {
		t.Fatalf("未登录申诉审核结果应当 401，实际 %d", s)
	}
	// 非作者（超管）：403。超管也不是作者 —— 这条证明判定看的是归属，不是权限点。
	if s, _ := admin.do(http.MethodPost, appealPath, "{\"reason\":\"我是管理员\"}"); s != http.StatusForbidden {
		t.Fatalf("非作者申诉应当 403，实际 %d", s)
	}
	// 作者本人：201 + 单号。
	first := bob.mustDo(http.StatusCreated, http.MethodPost, appealPath,
		"{\"reason\":\"AI 把地图编辑器的截图当成外链了\"}")
	firstNo := jsonField(t, first, "data", "no")
	// 幂等：再点一次是 200 + 同一条（拍板 §10.10-1）。
	second := bob.mustDo(http.StatusOK, http.MethodPost, appealPath, "{\"reason\":\"再点一次\"}")
	if again := jsonField(t, second, "data", "no"); again != firstNo {
		t.Fatalf("重复提交应当复用既有那条（%s），实际 %s", firstNo, again)
	}
	// 库里只有一条（幂等不是「界面上看着像」）。
	var n int
	if err := in.Pool.QueryRow(ctx,
		"SELECT count(*) FROM appeals WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1::uuid)",
		topicID).Scan(&n); err != nil {
		t.Fatalf("数申诉: %v", err)
	}
	if n != 1 {
		t.Fatalf("同一篇帖子的未处理申诉应当只有 1 条，实际 %d", n)
	}
	// 「我的申诉」看得到它（C5 的「作者能看到结果」），并且**带上那篇帖子的对外 id 与
	// 此刻的审核态**（前端要能链回帖子，也要能显示「已进入人工复核」）。
	// 注意 C5 的 201 回执是 SubmitResult（单号 / 时限 / 状态），没有这些字段 —— 它们是列表项的。
	mine2 := bob.mustDo(http.StatusOK, http.MethodGet, "/api/v1/me/appeals", "")
	if !strings.Contains(mine2, firstNo) {
		t.Fatalf("我的申诉里没有 %s:\n%s", firstNo, mine2)
	}
	var mineItem map[string]any
	if err := json.Unmarshal([]byte(mine2), &mineItem); err != nil {
		t.Fatalf("我的申诉不是 JSON: %v", err)
	}
	items, _ := mineItem["data"].([]any)
	var got map[string]any
	for _, it := range items {
		row, _ := it.(map[string]any)
		if row["no"] == firstNo {
			got = row
		}
	}
	if got == nil {
		t.Fatalf("我的申诉里找不到 %s:\n%s", firstNo, mine2)
	}
	if got["topic_id"] != topicID {
		t.Fatalf("申诉列表项的 topic_id 应当是那篇帖子的对外 id %s，实际 %v", topicID, got["topic_id"])
	}
	if got["topic_review_state"] != "rejected" {
		t.Fatalf("申诉列表项的 topic_review_state 应为 rejected（还没改判），实际 %v", got["topic_review_state"])
	}
	// 管理员处理 C5 这条时「改判」要真的放行那篇帖子 —— 否则就是「端点声称做到的事没做到」。
	// root 是超管（post.review 短路通过）。
	overturn := admin.mustDo(http.StatusOK, http.MethodPatch, "/api/v1/admin/appeals",
		fmt.Sprintf("{\"no\":%q,\"decision\":\"overturned\",\"response\":\"误判，已恢复展示。\",\"close\":true}", firstNo))
	if got := jsonField(t, overturn, "data", "decision"); got != "overturned" {
		t.Fatalf("decision 应为 overturned，实际 %q\n%s", got, overturn)
	}
	// 帖子的 review_state 真的变了（本文件里最重要的断言：改判不是一个字段）。
	topic := admin.mustDo(http.StatusOK, http.MethodGet, "/api/v1/topics/"+topicID, "")
	if got := jsonField(t, topic, "data", "review_state"); got != "approved" {
		t.Fatalf("改判之后帖子的 review_state 应为 approved，实际 %q\n%s", got, topic)
	}
	// 人工判定落在 review_events 里（0020 建这张表就是为了回答「谁判的、判过几次」）。
	// 按**这一条申诉**数（reason 里带着改判那条的文案）：forum 的人工判定自己也写 manual 行，
	// 所以「这张表里有几行」不是本用例要证的事，「这条申诉留了几行」才是。
	var events int
	if err := in.Pool.QueryRow(ctx,
		"SELECT count(*) FROM review_events WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1::uuid) AND source = 'manual' AND reason LIKE $2::varchar",
		topicID, "%"+firstNo+"%").Scan(&events); err != nil {
		t.Fatalf("数 review_events: %v", err)
	}
	if events != 1 {
		t.Fatalf("改判应当为 %s 在 review_events 里留一行 manual，实际 %d 行", firstNo, events)
	}
	// 幂等重放不会再写一行：再判一次是 409（上面已经断言过那条），这里把「表里也只有一行」钉住。
	if s, _ := admin.do(http.MethodPatch, "/api/v1/admin/appeals",
		fmt.Sprintf("{\"no\":%q,\"decision\":\"overturned\",\"response\":\"再判一次\"}", firstNo)); s != http.StatusConflict {
		t.Fatalf("重复改判应当 409，实际 %d", s)
	}
	var again int
	if err := in.Pool.QueryRow(ctx,
		"SELECT count(*) FROM review_events WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1::uuid) AND source = 'manual' AND reason LIKE $2::varchar",
		topicID, "%"+firstNo+"%").Scan(&again); err != nil {
		t.Fatalf("再数 review_events: %v", err)
	}
	if again != 1 {
		t.Fatalf("重放之后 review_events 里仍应只有 1 行，实际 %d 行", again)
	}
	// 队列按单号搜得到，并且带上 topic 那一列（管理员要看「改判改的是哪篇」）。
	q3 := admin.mustDo(http.StatusOK, http.MethodGet, "/api/v1/admin/appeals?q="+firstNo, "")
	if !strings.Contains(q3, topicID) {
		t.Fatalf("队列按单号 %s 搜不到，或没带 topic_id:\n%s", firstNo, q3)
	}
}

// newE2EModules 起一套真库 + 真装配（与 e2e_test.go 的主链路同一套）。
func newE2EModules(t *testing.T, ctx context.Context, cfg *config.Config, sink *logSink) (*Infra, *Modules) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo}))
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	t.Cleanup(in.Close)
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		t.Fatalf("newModules: %v", err)
	}
	if err := selfCheck(ctx, m, in); err != nil {
		t.Fatalf("启动自检失败（run 会拒绝启动的那种错）: %v", err)
	}
	registerTasks(in, m)
	// 两个后台循环都要真跑：worker 消费队列（注册的激活码信就是它发出去的），
	// cron 在启动时入队 queue:cleanup。少了 worker，注册会停在「码永远不来」。
	wctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	go func() { _ = in.Worker.Run(wctx) }()
	go func() { _ = runCron(wctx, in) }()
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("服务端日志尾部:\n%s", tail(sink.String(), 4000))
		}
	})
	return in, m
}

// newAPIClient 造一个带独立 Cookie 罐的客户端（= 一个独立的浏览器会话）。
func newAPIClient(t *testing.T, base string) *apiClient {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	return &apiClient{t: t, base: base, c: &http.Client{Jar: jar, Timeout: 20 * time.Second}}
}

// 编译期断言：接线里注入的适配器仍然满足本域的小接口。
// 它们改动时在这里就红，而不是等到线上「队列里一个空名字」。
var (
	_ appeal.TopicLookup   = appealTopics{}
	_ appeal.AccountLookup = appealAccounts{}
	_ appeal.Reviewer      = appealReviewer{}
	_ appeal.Notifier      = appealNotify{}
	_ appeal.Auditor       = appealAudit{}
	_ appeal.EventRecorder = appealEvents{}
	_                      = json.Marshal
)

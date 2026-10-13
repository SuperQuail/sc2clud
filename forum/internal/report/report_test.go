package report_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	"forum/internal/report"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

type harness struct {
	t       *testing.T
	ctx     context.Context
	pool    *pgxpool.Pool
	db      *ent.Client
	svc     *report.Service
	clk     *clock.Fake
	targets *fakeResolver
	users   *fakeUsers
	review  *fakeReview
	roleID  int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = db.Close() })

	h := &harness{
		t: t, ctx: ctx, pool: pool, db: db,
		clk:     &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
		targets: newFakeResolver(),
		users:   &fakeUsers{byID: map[int64]report.UserBrief{}},
		review:  &fakeReview{},
	}
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM roles ORDER BY id LIMIT 1").Scan(&h.roleID); err != nil {
		t.Fatalf("读角色: %v", err)
	}
	h.svc = report.NewService(db, h.targets, h.users, h.settings(3, 5), h.review, audit.New(db, h.clk), h.clk, testLogger())
	return h
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

// newUser 建一个真用户（reports.reporter_id 有外键）并登记进假的用户画像。
func (h *harness) newUser(handle string) *authz.Actor {
	h.t.Helper()
	publicID := uuid.New()
	var id int64
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
		 VALUES ($1::uuid, $2::varchar, $3::varchar, 'x', $4::varchar, $5::bigint) RETURNING id`,
		publicID, handle, handle+"@example.com", strings.ToUpper(handle[:1])+handle[1:], h.roleID).Scan(&id); err != nil {
		h.t.Fatalf("建用户 %s: %v", handle, err)
	}
	h.users.byID[id] = report.UserBrief{PublicID: publicID.String(), Handle: handle, Nickname: handle}
	return &authz.Actor{UserID: id, PublicID: publicID.String(), Status: "active"}
}

// admin 是持 report.handle 的管理员。
func (h *harness) admin() *authz.Actor {
	a := h.newUser("admin" + uuid.NewString()[:6])
	a.Perms = authz.NewSet(authz.PermReportHandle)
	return a
}

func (h *harness) topic(author *authz.Actor, label string) (publicID string, internalID int64) {
	h.t.Helper()
	publicID = uuid.NewString()
	internalID = h.targets.add(report.TargetTopic, publicID, report.TargetInfo{
		InternalID: 0, PublicID: publicID, AuthorID: author.UserID, Label: label,
		Board: &report.BoardRef{Slug: "general", Name: "综合"},
	})
	return publicID, internalID
}

func (h *harness) scalar(sqlText string, args ...any) int64 {
	h.t.Helper()
	var n int64
	if err := h.pool.QueryRow(h.ctx, sqlText, args...).Scan(&n); err != nil {
		h.t.Fatalf("标量查询 %q: %v", sqlText, err)
	}
	return n
}

// settings 是一个只有阈值的 Settings 假件。
func (h *harness) settings(th1, th2 int) report.Settings {
	return fakeSettings{th1: th1, th2: th2}
}

// svcWith 换掉阈值（返回一个新的 Service，其余依赖不变）。
func (h *harness) svcWith(th1, th2 int) *report.Service {
	return report.NewService(h.db, h.targets, h.users, h.settings(th1, th2), h.review, audit.New(h.db, h.clk), h.clk, testLogger())
}

// ============================================================
// 举报创建
// ============================================================

func TestCreateReport(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	topicPublicID, topicID := h.topic(author, "被举报的主题")

	out, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam", Detail: "刷屏",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Created {
		t.Fatal("新建举报应当 created = true")
	}
	if out.TargetLabel != "被举报的主题" || out.Board == nil || out.Board.Slug != "general" {
		t.Fatalf("目标画像不对: %+v", out)
	}
	if out.Reporter == nil || out.Reporter.Handle != "reporter" {
		t.Fatalf("举报人画像不对: %+v", out.Reporter)
	}
	if out.State != "open" || out.OpenReports != 1 {
		t.Fatalf("新举报: state = %s, open_reports = %d，想要 open, 1", out.State, out.OpenReports)
	}
	if n := h.scalar("SELECT count(*) FROM reports WHERE target_id = $1::bigint", topicID); n != 1 {
		t.Fatalf("reports 行数 = %d，想要 1", n)
	}
}

func TestCreateReportRejectsMissingAndSelf(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	_, topicID := h.topic(author, "主题")

	// 目标不存在 → 404
	_, err := h.svc.Create(h.ctx, h.newUser("r1"), report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: uuid.NewString(), Reason: "spam",
	})
	if !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("目标不存在: err = %v，想要 404", err)
	}

	// 举报自己的内容 → 400（U4：自己的内容自己删，举报自己是队列噪音）
	out, err := h.svc.Create(h.ctx, author, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: h.targets.publicOf(topicID), Reason: "spam",
	})
	if err == nil {
		t.Fatalf("举报自己应当 400，实际成功: %+v", out)
	}
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != 400 {
		t.Fatalf("举报自己: err = %v，想要 400", err)
	}
}

func TestCreateReportIsIdempotent(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	topicPublicID, _ := h.topic(author, "主题")

	first, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "abuse", Detail: "补充说明",
	})
	if err != nil {
		t.Fatalf("重复举报不该报错（拍板 §8.11 U5）: %v", err)
	}
	if second.ID != first.ID || second.Created {
		t.Fatalf("重复举报应当返回既有那条: id %s vs %s, created=%v", second.ID, first.ID, second.Created)
	}
	if n := h.scalar("SELECT count(*) FROM reports"); n != 1 {
		t.Fatalf("reports 行数 = %d，想要 1", n)
	}
	// 原始理由不该被第二次请求改写
	if second.Reason != "spam" {
		t.Fatalf("重复举报改写了理由: %s", second.Reason)
	}
}

// TestReReportAfterDismissed 是 uq_reports_once 那个部分谓词存在的理由：
// 驳回之后同一个人必须能再举报一次（普通唯一索引会让这条路径永久 409）。
func TestReReportAfterDismissed(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	admin := h.admin()
	topicPublicID, _ := h.topic(author, "主题")

	first, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Handle(h.ctx, admin, first.ID, report.HandleInput{State: "dismissed"}); err != nil {
		t.Fatal(err)
	}
	second, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "abuse",
	})
	if err != nil {
		t.Fatalf("驳回之后再举报应当成功: %v", err)
	}
	if !second.Created || second.ID == first.ID {
		t.Fatalf("驳回之后再举报应当是新的那条: %+v", second)
	}
	if n := h.scalar("SELECT count(*) FROM reports"); n != 2 {
		t.Fatalf("reports 行数 = %d，想要 2", n)
	}
}

// ============================================================
// 处理
// ============================================================

func TestHandleReport(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	admin := h.admin()
	topicPublicID, _ := h.topic(author, "主题")
	created, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	})
	if err != nil {
		t.Fatal(err)
	}

	// handled 必须写说明
	if _, err := h.svc.Handle(h.ctx, admin, created.ID, report.HandleInput{State: "handled"}); err == nil {
		t.Fatal("标记已处理但不写说明应当 400")
	}

	out, err := h.svc.Handle(h.ctx, admin, created.ID, report.HandleInput{State: "handled", Note: "已删除并警告"})
	if err != nil {
		t.Fatal(err)
	}
	if out.State != "handled" || out.Handler == nil || out.HandledAt == nil {
		t.Fatalf("处理之后的形态不对: %+v", out)
	}
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE action = 'report.handle'"); n != 1 {
		t.Fatalf("审计行数 = %d，想要 1", n)
	}

	// 终态再处理 → 409，且审计不增
	_, err = h.svc.Handle(h.ctx, admin, created.ID, report.HandleInput{State: "dismissed", Note: "改主意了"})
	if !errors.Is(err, report.ErrAlreadyHandled) {
		t.Fatalf("终态再处理: err = %v，想要 report.already_handled", err)
	}
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE action = 'report.handle'"); n != 1 {
		t.Fatalf("重放之后审计行数 = %d，想要 1（不写第二份审计）", n)
	}

	// dismissed 不写说明是允许的
	second, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "other",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Handle(h.ctx, admin, second.ID, report.HandleInput{State: "dismissed"}); err != nil {
		t.Fatalf("驳回不写说明应当允许: %v", err)
	}
}

func TestHandleRequiresPermission(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	topicPublicID, _ := h.topic(author, "主题")
	created, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	})
	if err != nil {
		t.Fatal(err)
	}
	// service 层兜底：普通用户（不走路由也挡住）
	if _, err := h.svc.Handle(h.ctx, reporter, created.ID, report.HandleInput{State: "handled", Note: "x"}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("普通用户处理举报: err = %v，想要 403", err)
	}
	if _, err := h.svc.ListQueue(h.ctx, reporter, report.QueueInput{}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("普通用户看队列: err = %v，想要 403", err)
	}
	if _, err := h.svc.Handle(h.ctx, nil, created.ID, report.HandleInput{State: "handled", Note: "x"}); !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("nil actor: err = %v，想要 401", err)
	}
}

// TestHandleConcurrent：两个管理员同时处理同一条 → 一个成功一个 409，审计恰好一条。
func TestHandleConcurrent(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	admin1, admin2 := h.admin(), h.admin()
	topicPublicID, _ := h.topic(author, "主题")
	created, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, admin := range []*authz.Actor{admin1, admin2} {
		wg.Add(1)
		go func(i int, admin *authz.Actor) {
			defer wg.Done()
			_, errs[i] = h.svc.Handle(h.ctx, admin, created.ID, report.HandleInput{State: "handled", Note: "并发"})
		}(i, admin)
	}
	wg.Wait()

	okCount, conflictCount := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			okCount++
		case errors.Is(err, report.ErrAlreadyHandled):
			conflictCount++
		default:
			t.Fatalf("意外错误: %v", err)
		}
	}
	if okCount != 1 || conflictCount != 1 {
		t.Fatalf("并发处理结果 = %d 成功 / %d 冲突，想要 1 / 1", okCount, conflictCount)
	}
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE action = 'report.handle'"); n != 1 {
		t.Fatalf("审计行数 = %d，想要 1", n)
	}
	if state := h.stateOf(created.ID); state != "handled" {
		t.Fatalf("最终状态 = %s，想要 handled", state)
	}
}

func TestHandleBatchIsPerItem(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	reporter := h.newUser("reporter")
	admin := h.admin()

	var ids []string
	for i := 0; i < 3; i++ {
		topicPublicID, _ := h.topic(author, fmt.Sprintf("主题 %d", i))
		out, err := h.svc.Create(h.ctx, reporter, report.CreateReportInput{
			TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, out.ID)
	}
	// 先把第一条处理掉，批处理里它应当报冲突，另外两条成功
	if _, err := h.svc.Handle(h.ctx, admin, ids[0], report.HandleInput{State: "dismissed"}); err != nil {
		t.Fatal(err)
	}

	res, err := h.svc.HandleBatch(h.ctx, admin, report.BatchHandleInput{IDs: ids, State: "handled", Note: "批量"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Results) != 3 {
		t.Fatalf("结果条数 = %d，想要 3", len(res.Results))
	}
	if res.Results[0].OK || res.Results[0].Code != report.ErrAlreadyHandled.Code {
		t.Fatalf("第一条应当冲突: %+v", res.Results[0])
	}
	if !res.Results[1].OK || !res.Results[2].OK {
		t.Fatalf("后两条应当成功: %+v", res.Results)
	}
	if n := h.scalar("SELECT count(*) FROM reports WHERE state = 'handled'"); n != 2 {
		t.Fatalf("handled 行数 = %d，想要 2（冲突的那条保持 dismissed）", n)
	}
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE action = 'report.handle'"); n != 3 {
		t.Fatalf("审计行数 = %d，想要 3（含先前单条那次）", n)
	}
}

// ============================================================
// 阈值触发复核（拍板 §10.4）
// ============================================================

func TestReportThresholdsTriggerReview(t *testing.T) {
	h := newHarness(t)
	h.svc = h.svcWith(3, 5)
	author := h.newUser("author")
	topicPublicID, topicID := h.topic(author, "会被反复举报的主题")

	// 前两位举报人：还没到阈值 1
	for i := 0; i < 2; i++ {
		who := h.newUser(fmt.Sprintf("r%d", i))
		if _, err := h.svc.Create(h.ctx, who, report.CreateReportInput{
			TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(h.review.calls()); n != 0 {
		t.Fatalf("未到阈值就触发了复核: %d 次", n)
	}

	// 第三位：到阈值 1 → 触发一次（不是「人工」）
	if _, err := h.svc.Create(h.ctx, h.newUser("r3"), report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	}); err != nil {
		t.Fatal(err)
	}
	calls := h.review.calls()
	if len(calls) != 1 {
		t.Fatalf("到阈值 1 应当触发一次复核，实际 %d 次", len(calls))
	}
	if calls[0].TopicID != topicID || calls[0].OpenReports != 3 || calls[0].Human {
		t.Fatalf("阈值 1 的触发形状不对: %+v", calls[0])
	}

	// 第四位：没到阈值 2，不再触发
	if _, err := h.svc.Create(h.ctx, h.newUser("r4"), report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	}); err != nil {
		t.Fatal(err)
	}
	if n := len(h.review.calls()); n != 1 {
		t.Fatalf("阈值 1 与 2 之间不该重复触发，实际 %d 次", n)
	}

	// 第五位：到阈值 2 → 直接进人工
	r5 := h.newUser("r5")
	if _, err := h.svc.Create(h.ctx, r5, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	}); err != nil {
		t.Fatal(err)
	}
	calls = h.review.calls()
	if len(calls) != 2 {
		t.Fatalf("到阈值 2 应当再触发一次，实际 %d 次", len(calls))
	}
	if !calls[1].Human || calls[1].OpenReports != 5 {
		t.Fatalf("阈值 2 的触发形状不对（应当 Human=true）: %+v", calls[1])
	}

	// 重复举报（同一个人再报同一个目标）不该再触发：它复用既有那条
	if _, err := h.svc.Create(h.ctx, r5, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
	}); err != nil {
		t.Fatal(err)
	}
	if n := len(h.review.calls()); n != 2 {
		t.Fatalf("重复举报不该再触发复核，实际 %d 次", n)
	}

	// 非主题目标（回复/用户）不进复核：复核是内容审核的动作
	postPublicID := uuid.NewString()
	h.targets.add(report.TargetPost, postPublicID, report.TargetInfo{
		PublicID: postPublicID, AuthorID: author.UserID, Label: "回复 #1",
	})
	for i := 0; i < 3; i++ {
		if _, err := h.svc.Create(h.ctx, h.newUser(fmt.Sprintf("p%d", i)), report.CreateReportInput{
			TargetType: report.TargetPost, TargetID: postPublicID, Reason: "abuse",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(h.review.calls()); n != 2 {
		t.Fatalf("回复被举报不该触发内容复核，实际 %d 次", n)
	}
}

// ============================================================
// 队列与我的举报
// ============================================================

func TestQueueFilterAndPagination(t *testing.T) {
	h := newHarness(t)
	author := h.newUser("author")
	admin := h.admin()
	var created []string
	for i := 0; i < 3; i++ {
		topicPublicID, _ := h.topic(author, fmt.Sprintf("主题 %d", i))
		// 每次往前挪一秒，保证 created_at 严格递减的游标顺序
		h.clk.T = h.clk.T.Add(time.Second)
		out, err := h.svc.Create(h.ctx, h.newUser(fmt.Sprintf("reporter%d", i)), report.CreateReportInput{
			TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "spam",
		})
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, out.ID)
	}
	if _, err := h.svc.Handle(h.ctx, admin, created[0], report.HandleInput{State: "dismissed"}); err != nil {
		t.Fatal(err)
	}

	// 只筛 open
	page, err := h.svc.ListQueue(h.ctx, admin, report.QueueInput{State: "open"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("open 队列 = %d 条，想要 2", len(page.Items))
	}

	// 游标翻页：limit=1 → 下一页游标非空，两页不重复
	first, err := h.svc.ListQueue(h.ctx, admin, report.QueueInput{CursorInput: report.CursorInput{Limit: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("第一页 = %d 条, cursor = %q", len(first.Items), first.NextCursor)
	}
	second, err := h.svc.ListQueue(h.ctx, admin, report.QueueInput{CursorInput: report.CursorInput{Limit: 1, Cursor: first.NextCursor}})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 {
		t.Fatalf("第二页 = %d 条，想要 1", len(second.Items))
	}
	if second.Items[0].ID == first.Items[0].ID {
		t.Fatal("两页出现了同一条（游标没生效）")
	}

	// 伪造的游标 → 400
	if _, err := h.svc.ListQueue(h.ctx, admin, report.QueueInput{CursorInput: report.CursorInput{Cursor: "!!!not-base64"}}); err == nil {
		t.Fatal("伪造游标应当 400")
	}

	// 我的举报只返回自己的
	me := h.newUser("only-mine")
	topicPublicID, _ := h.topic(author, "给我报的")
	if _, err := h.svc.Create(h.ctx, me, report.CreateReportInput{
		TargetType: report.TargetTopic, TargetID: topicPublicID, Reason: "other",
	}); err != nil {
		t.Fatal(err)
	}
	mine, err := h.svc.ListMine(h.ctx, me, report.CursorInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Items) != 1 {
		t.Fatalf("我的举报 = %d 条，想要 1", len(mine.Items))
	}
}

func (h *harness) stateOf(publicID string) string {
	h.t.Helper()
	var s string
	if err := h.pool.QueryRow(h.ctx, "SELECT state FROM reports WHERE public_id = $1::uuid", publicID).Scan(&s); err != nil {
		h.t.Fatalf("读举报状态: %v", err)
	}
	return s
}

// ---- 假依赖 ----

type fakeResolver struct {
	mu      sync.Mutex
	byKey   map[string]report.TargetInfo // type:publicID
	byID    map[string]report.TargetInfo // type:internalID
	nextID  int64
	publics map[int64]string
}

func newFakeResolver() *fakeResolver {
	return &fakeResolver{
		byKey: map[string]report.TargetInfo{}, byID: map[string]report.TargetInfo{},
		publics: map[int64]string{}, nextID: 100,
	}
}

func (f *fakeResolver) add(targetType, publicID string, info report.TargetInfo) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	info.InternalID = f.nextID
	info.PublicID = publicID
	f.byKey[targetType+":"+publicID] = info
	f.byID[targetType+":"+fmt.Sprint(info.InternalID)] = info
	f.publics[info.InternalID] = publicID
	return info.InternalID
}

func (f *fakeResolver) publicOf(internalID int64) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.publics[internalID]
}

func (f *fakeResolver) ResolveTarget(_ context.Context, targetType, publicID string) (report.TargetInfo, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, ok := f.byKey[targetType+":"+publicID]
	return info, ok, nil
}

func (f *fakeResolver) TargetInfo(_ context.Context, targetType string, internalID int64) (report.TargetInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, ok := f.byID[targetType+":"+fmt.Sprint(internalID)]
	if !ok {
		return report.TargetInfo{}, fmt.Errorf("目标不存在: %s/%d", targetType, internalID)
	}
	return info, nil
}

type fakeUsers struct{ byID map[int64]report.UserBrief }

func (f *fakeUsers) Basic(_ context.Context, userID int64) (report.UserBrief, error) {
	b, ok := f.byID[userID]
	if !ok {
		return report.UserBrief{}, fmt.Errorf("用户不存在: %d", userID)
	}
	return b, nil
}

type fakeSettings struct{ th1, th2 int }

func (f fakeSettings) SettingInt(_ context.Context, key string) int {
	switch key {
	case "ai.review.report_threshold_1":
		return f.th1
	case "ai.review.report_threshold_2":
		return f.th2
	}
	return 0
}

type fakeReview struct {
	mu   sync.Mutex
	seen []report.ReportReviewInput
}

func (f *fakeReview) TriggerReportReview(_ context.Context, _ *ent.Tx, in report.ReportReviewInput) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, in)
	return nil
}

func (f *fakeReview) calls() []report.ReportReviewInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]report.ReportReviewInput(nil), f.seen...)
}

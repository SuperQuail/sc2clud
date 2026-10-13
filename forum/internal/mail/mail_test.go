package mail_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
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

	"forum/internal/auth"
	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/mail"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	platformdb "forum/internal/platform/db"
	pgmail "forum/internal/platform/mail"
	"forum/internal/platform/queue"
	"forum/internal/platform/queue/pgqueue"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// 编译期断言：本模块实现的形状**就是** auth 期望的那两个接口（拍板 §12.2 的接线点）。
// auth 是使用方，接口在它那里定义；这两行让「签名漂了」在编译期就红，而不是等到 app 接线。
var (
	_ auth.MailAccounts = (*mail.Service)(nil) // HasUsable(ctx) (bool, error)
	_ auth.Mailer       = (*mail.Service)(nil) // SendVerifyCode(ctx, userID, to, code, template) (int64, error)
)

// app 层把 pgqueue 直接当 Queue 注入（不需要 adapter）：这里钉住那个形状。
var _ mail.Queue = (*pgqueue.Queue)(nil)

// testKey 是测试主密钥（32 字节 hex）；otherKey 用来造「换了主密钥」的账号。
const testKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
const otherKey = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"

type harness struct {
	t        *testing.T
	ctx      context.Context
	pool     *pgxpool.Pool
	db       *ent.Client
	svc      *mail.Service
	clk      *clock.Fake
	queue    *fakeQueue
	settings *fakeSettings
	userID   int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = db.Close() })

	h := &harness{
		t: t, ctx: ctx, pool: pool, db: db,
		clk:      &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
		queue:    &fakeQueue{},
		settings: &fakeSettings{enabled: true, siteName: "测试站"},
	}
	h.svc = mail.NewService(db, mail.Keys{KeyHex: testKey}, h.queue, h.settings, audit.New(db, h.clk), h.clk, testLogger())
	// 审计行有 actor_id → users(id) 的外键，所以管理员必须是真的用户
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
		 VALUES ($1::uuid, 'admin', 'admin@example.com', 'x', '管理员', (SELECT id FROM roles ORDER BY id LIMIT 1))
	  RETURNING id`, uuid.New()).Scan(&h.userID); err != nil {
		t.Fatalf("建管理员: %v", err)
	}
	return h
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// applyMigrations 顺序执行 migrations/postgres/*.up.sql —— 必须跑**仓库真迁移**建表：
// 用 ent.Schema.Create 会让 ent 与迁移的漂移在测试里看不见。
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

// ---- 夹具 ----

type testAccount struct {
	PublicID string
	ID       int64
	Name     string
}

// newAccount 走 service 的真路径建账号（凭据真的被加密）。
func (h *harness) newAccount(name, provider string, priority, limit int, secret, options string) testAccount {
	h.t.Helper()
	in := mail.AccountInput{
		Name: name, Provider: provider, Priority: &priority, DailyLimit: &limit,
		FromAddress: "no-reply@example.com", FromName: "SC2Clud",
	}
	if secret != "" {
		in.Secret = json.RawMessage(secret)
	}
	if options != "" {
		in.Options = json.RawMessage(options)
	}
	out, err := h.svc.CreateAccount(h.ctx, h.adminActor(), in)
	if err != nil {
		h.t.Fatalf("建账号 %s: %v", name, err)
	}
	return testAccount{PublicID: out.ID, ID: h.accountID(out.ID), Name: name}
}

func (h *harness) accountID(publicID string) int64 {
	h.t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx,
		"SELECT id FROM mail_accounts WHERE public_id = $1::uuid", publicID).Scan(&id); err != nil {
		h.t.Fatalf("读账号 id: %v", err)
	}
	return id
}

func (h *harness) adminActor() *authz.Actor {
	return &authz.Actor{UserID: h.userID, Perms: authz.NewSet(authz.PermMailManage), Status: "active"}
}

// enqueue 走真路径建投递记录（同一事务里 EnqueueTx），返回 mail_logs.id。
func (h *harness) enqueue(in mail.EnqueueInput) int64 {
	h.t.Helper()
	if in.IdempotencyKey == "" {
		in.IdempotencyKey = "test:" + uuid.NewString()
	}
	if err := platformdb.WithTx(h.ctx, h.db, func(tx *ent.Tx) error {
		return h.svc.EnqueueTx(h.ctx, tx, in)
	}); err != nil {
		h.t.Fatalf("入队投递: %v", err)
	}
	var id int64
	if err := h.pool.QueryRow(h.ctx,
		"SELECT id FROM mail_logs WHERE idempotency_key = $1::varchar", in.IdempotencyKey).Scan(&id); err != nil {
		h.t.Fatalf("读投递记录: %v", err)
	}
	return id
}

func (h *harness) payload(logID int64) []byte {
	b, err := json.Marshal(map[string]int64{"id": logID})
	if err != nil {
		h.t.Fatal(err)
	}
	return b
}

type logRow struct {
	Status       string
	Attempts     int
	Error        string
	Provider     string
	SentAt       *time.Time
	QuotaAccount *int64
	QuotaDay     string
	Template     string
	To           string
	Payload      string
}

func (h *harness) log(logID int64) logRow {
	h.t.Helper()
	var r logRow
	err := h.pool.QueryRow(h.ctx, `SELECT status, attempts, COALESCE(error, ''), provider, sent_at,
              quota_account_id, COALESCE(quota_day::text, ''), template, to_address, payload::text
         FROM mail_logs WHERE id = $1::bigint`, logID).
		Scan(&r.Status, &r.Attempts, &r.Error, &r.Provider, &r.SentAt,
			&r.QuotaAccount, &r.QuotaDay, &r.Template, &r.To, &r.Payload)
	if err != nil {
		h.t.Fatalf("读投递记录 %d: %v", logID, err)
	}
	return r
}

func (h *harness) quota(accountID int64, day string) int {
	h.t.Helper()
	var n int
	err := h.pool.QueryRow(h.ctx,
		"SELECT count FROM mail_quota WHERE account_id = $1::bigint AND day = $2::date", accountID, day).Scan(&n)
	if err != nil {
		return 0
	}
	return n
}

func (h *harness) mustExec(sqlText string, args ...any) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx, sqlText, args...); err != nil {
		h.t.Fatalf("执行 %q: %v", sqlText, err)
	}
}

// day 是测试时钟那一刻在 tz 里的自然日（与 SQL 里 AT TIME ZONE 的口径一致）。
func (h *harness) day(tz string) string {
	h.t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		h.t.Fatal(err)
	}
	return h.clk.Now().In(loc).Format("2006-01-02")
}

// ---- 假依赖 ----

type fakeQueue struct {
	mu    sync.Mutex
	tasks []queue.Task
}

func (f *fakeQueue) Enqueue(_ context.Context, t queue.Task) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tasks = append(f.tasks, t)
	return nil
}

func (f *fakeQueue) EnqueueTx(_ context.Context, _ queue.TxExecutor, t queue.Task) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tasks = append(f.tasks, t)
	return nil
}

func (f *fakeQueue) all() []queue.Task {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]queue.Task(nil), f.tasks...)
}

type fakeSettings struct {
	enabled  bool
	siteName string
}

func (f *fakeSettings) Setting(_ context.Context, key string) string {
	if key == "site.name" {
		return f.siteName
	}
	return ""
}

func (f *fakeSettings) SettingBool(_ context.Context, key string) bool {
	if key == "mail.enabled" {
		return f.enabled
	}
	return true
}

// noopStore 只给「直接构造 Router」的一致性测试用：它不写业务表。
type noopStore struct{ bound []string }

func (s *noopStore) BindQuota(_ context.Context, accountID int64, day string) error {
	s.bound = append(s.bound, fmt.Sprintf("%d@%s", accountID, day))
	return nil
}

func (s *noopStore) Report(context.Context, int64, error) error { return nil }

func testCrypter(t *testing.T, key string) *pgmail.Crypter {
	t.Helper()
	c, err := pgmail.NewCrypter(key)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// ============================================================
// HasUsable（拍板 §12.2 的判定点）
// ============================================================

func TestHasUsable(t *testing.T) {
	h := newHarness(t)

	if ok, err := h.svc.HasUsable(h.ctx); err != nil || ok {
		t.Fatalf("一个账号都没有: HasUsable = %v, %v，想要 false, nil", ok, err)
	}

	acct := h.newAccount("main", "log", 10, 100, `{"api_key":"k"}`, "")
	if ok, err := h.svc.HasUsable(h.ctx); err != nil || !ok {
		t.Fatalf("有可用账号: HasUsable = %v, %v，想要 true, nil", ok, err)
	}

	// 唯一账号被停用 → 不再可用（注册路径据此回 503 auth.mail_unavailable）
	disabled, enabled := false, true
	if _, err := h.svc.UpdateAccount(h.ctx, h.adminActor(), acct.PublicID, mail.AccountPatch{Enabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := h.svc.HasUsable(h.ctx); ok {
		t.Fatal("唯一账号被停用后 HasUsable 应为 false")
	}
	if _, err := h.svc.UpdateAccount(h.ctx, h.adminActor(), acct.PublicID, mail.AccountPatch{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := h.svc.HasUsable(h.ctx); !ok {
		t.Fatal("重新启用之后应恢复可用")
	}
}

// TestHasUsableRejectsUndecryptableAccounts：能解开的才算可用 —— 换了主密钥、或密文是垃圾字节。
func TestHasUsableRejectsUndecryptableAccounts(t *testing.T) {
	h := newHarness(t)

	pid := uuid.New()
	crypt := testCrypter(t, otherKey)
	cipher, nonce, err := crypt.Encrypt([]byte(`{"api_key":"k"}`), []byte(pid.String()))
	if err != nil {
		t.Fatal(err)
	}
	h.mustExec(`INSERT INTO mail_accounts (public_id, name, provider, from_address, secret_cipher, secret_nonce)
	           VALUES ($1::uuid, 'wrong-key', 'resend', 'x@example.com', $2::bytea, $3::bytea)`, pid, cipher, nonce)

	if ok, err := h.svc.HasUsable(h.ctx); err != nil || ok {
		t.Fatalf("换了主密钥的账号: HasUsable = %v, %v，想要 false, nil", ok, err)
	}

	h.mustExec(`UPDATE mail_accounts
	            SET secret_cipher = decode('01deadbeef', 'hex'), secret_nonce = decode('000102030405060708090a0b', 'hex')
	          WHERE name = 'wrong-key'`)
	if ok, _ := h.svc.HasUsable(h.ctx); ok {
		t.Fatal("垃圾密文不该算可用")
	}
}

// TestHasUsableAgreesWithRouter：本模块的判定与 platform/mail.Router 的实际取账号行为必须同向
// （_P2-修正清单 §7.2 第 1 条：同一个事实两处各写一遍 → 要有一条检查证明两边一致）。
func TestHasUsableAgreesWithRouter(t *testing.T) {
	h := newHarness(t)
	store := &noopStore{}
	router := pgmail.NewRouter(pgmail.Dependencies{
		DB: h.db, Crypter: testCrypter(t, testKey), Store: store,
		Clock: h.clk, Log: testLogger(),
	})
	msg := pgmail.Message{To: "u@example.com", Subject: "s", Text: "t"}

	usable, _ := h.svc.HasUsable(h.ctx)
	err := router.Send(h.ctx, msg)
	if usable || err == nil {
		t.Fatalf("零账号: HasUsable = %v, Send err = %v，想要 false 与一个错误", usable, err)
	}

	h.newAccount("main", "log", 10, 100, `{"api_key":"k"}`, "")
	usable, _ = h.svc.HasUsable(h.ctx)
	if !usable {
		t.Fatal("有 log 账号时 HasUsable 应为 true")
	}
	if err := router.Send(h.ctx, msg); err != nil {
		t.Fatalf("Router.Send: %v", err)
	}
	if len(store.bound) != 1 {
		t.Fatalf("Router 占额度写回次数 = %d，想要 1", len(store.bound))
	}
}

// ============================================================
// 额度粒度：一次投递，不是一次尝试（d6 §2.5 / §8.3）
// ============================================================

func TestOneDeliveryOneQuotaUnit(t *testing.T) {
	h := newHarness(t)
	// 连不上的 SMTP：dial 被拒 → Classify 归为「临时」，可重试
	acct := h.newAccount("smtp-dead", "smtp", 10, 5,
		`{"username":"u","password":"p"}`, `{"host":"127.0.0.1","port":1,"tls":"none"}`)
	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "123456"},
	})
	day := h.day("Asia/Shanghai")

	for i := 1; i <= 2; i++ {
		err := h.svc.HandleMailSend(h.ctx, h.payload(logID))
		if err == nil || errors.Is(err, queue.ErrSkipRetry) {
			t.Fatalf("第 %d 次投递: err = %v，想要一个「可重试」的错误", i, err)
		}
		row := h.log(logID)
		if row.Status != "pending" || row.Attempts != i {
			t.Fatalf("第 %d 次之后: status = %s, attempts = %d，想要 pending, %d", i, row.Status, row.Attempts, i)
		}
		if row.QuotaAccount == nil || *row.QuotaAccount != acct.ID {
			t.Fatalf("第 %d 次之后投递记录没有绑到失败的那个账号: %v", i, row.QuotaAccount)
		}
		if n := h.quota(acct.ID, day); n != 1 {
			t.Fatalf("第 %d 次之后额度 = %d，想要 1（重试不能再占一次）", i, n)
		}
	}

	// 换成不碰网络的 provider：第三次成功，额度仍然只有 1
	h.mustExec("UPDATE mail_accounts SET provider = 'log' WHERE id = $1::bigint", acct.ID)
	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID)); err != nil {
		t.Fatalf("第 3 次投递: %v", err)
	}
	row := h.log(logID)
	if row.Status != "sent" || row.Attempts != 3 {
		t.Fatalf("第三次之后: status = %s, attempts = %d，想要 sent, 3", row.Status, row.Attempts)
	}
	if row.SentAt == nil {
		t.Fatal("sent 之后 sent_at 必须非空")
	}
	if row.Provider != "log" {
		t.Fatalf("provider 列 = %q，想要 log（排障要知道是哪条通道发出去的）", row.Provider)
	}
	if n := h.quota(acct.ID, day); n != 1 {
		t.Fatalf("三次尝试之后额度 = %d，想要 1 —— 这就是「一次投递占一次额度」", n)
	}
}

func TestSentIsIdempotent(t *testing.T) {
	h := newHarness(t)
	acct := h.newAccount("main", "log", 10, 5, `{"api_key":"k"}`, "")
	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "123456"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID)); err != nil {
		t.Fatal(err)
	}
	before := h.log(logID)

	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID)); err != nil {
		t.Fatalf("重放已发送的任务: %v，想要 nil", err)
	}
	after := h.log(logID)
	if after.Attempts != before.Attempts || !after.SentAt.Equal(*before.SentAt) {
		t.Fatalf("重放改变了记录: attempts %d → %d", before.Attempts, after.Attempts)
	}
	if n := h.quota(acct.ID, h.day("Asia/Shanghai")); n != 1 {
		t.Fatalf("重放之后额度 = %d，想要 1", n)
	}
}

func TestMailDisabledFailsWithoutTouchingAccounts(t *testing.T) {
	h := newHarness(t)
	acct := h.newAccount("main", "log", 10, 5, `{"api_key":"k"}`, "")
	h.settings.enabled = false

	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "123456"},
	})
	err := h.svc.HandleMailSend(h.ctx, h.payload(logID))
	if !errors.Is(err, queue.ErrSkipRetry) {
		t.Fatalf("mail.enabled=off: err = %v，想要 queue.ErrSkipRetry（不重试）", err)
	}
	if row := h.log(logID); row.Status != "failed" {
		t.Fatalf("mail.enabled=off: status = %s，想要 failed", row.Status)
	}
	if n := h.quota(acct.ID, h.day("Asia/Shanghai")); n != 0 {
		t.Fatalf("关掉总开关不该占额度，实际 %d", n)
	}
}

func TestNoUsableAccountLetsQueueRetry(t *testing.T) {
	h := newHarness(t)
	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "123456"},
	})
	err := h.svc.HandleMailSend(h.ctx, h.payload(logID))
	if err == nil {
		t.Fatal("一个账号都没有时应当把错误交回队列（等管理员配号）")
	}
	if errors.Is(err, queue.ErrSkipRetry) {
		t.Fatal("零账号是配置问题，不该直接进 dead")
	}
	row := h.log(logID)
	if row.Status != "pending" || row.Attempts != 1 {
		t.Fatalf("零账号: status = %s, attempts = %d，想要 pending, 1", row.Status, row.Attempts)
	}
	// 只应有最初那一条入队任务：没有「重排到明天」（那是额度问题，不是配置问题）
	if n := len(h.queue.all()); n != 1 {
		t.Fatalf("队列任务数 = %d，想要 1", n)
	}
}

func TestQuotaExhaustedRequeuesTomorrow(t *testing.T) {
	h := newHarness(t)
	acct := h.newAccount("only", "log", 10, 1, `{"api_key":"k"}`, "")
	day := h.day("Asia/Shanghai")

	first := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "111111"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(first)); err != nil {
		t.Fatal(err)
	}
	if n := h.quota(acct.ID, day); n != 1 {
		t.Fatalf("第一封之后额度 = %d，想要 1", n)
	}

	second := h.enqueue(mail.EnqueueInput{
		RecipientID: 2, ToAddress: "v@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "222222"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(second)); err != nil {
		t.Fatalf("额度用尽应当重排而不是报错（Return nil），实际 %v", err)
	}
	row := h.log(second)
	if row.Status != "pending" || row.Attempts != 1 {
		t.Fatalf("额度用尽: status = %s, attempts = %d，想要 pending, 1", row.Status, row.Attempts)
	}
	if n := h.quota(acct.ID, day); n != 1 {
		t.Fatalf("额度用尽之后计数 = %d，想要 1（不该再占）", n)
	}

	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 14, 0, 0, 0, 0, loc).Add(35 * time.Minute).UTC()
	var found bool
	for _, task := range h.queue.all() {
		if task.Type != queue.TypeMailSend || task.RunAt.IsZero() {
			continue
		}
		payload, _ := json.Marshal(task.Payload)
		if !strings.Contains(string(payload), fmt.Sprint(second)) {
			continue
		}
		found = true
		if !task.RunAt.Equal(want) {
			t.Fatalf("重排时间 = %s，想要 %s", task.RunAt.Format(time.RFC3339), want.Format(time.RFC3339))
		}
	}
	if !found {
		t.Fatal("额度用尽后应当把任务重排到下一个额度重置点")
	}
}

// ============================================================
// 账号 CRUD 与凭据
// ============================================================

func TestAccountsNeverLeakSecret(t *testing.T) {
	h := newHarness(t)
	const plaintext = "super-secret-value"
	acct := h.newAccount("main", "resend", 10, 5, `{"api_key":"super-secret-value"}`, "")

	list, err := h.svc.ListAccounts(h.ctx, h.adminActor())
	if err != nil {
		t.Fatal(err)
	}
	blob, err := json.Marshal(list)
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{plaintext, "secret_cipher", "secret_nonce", `"secret"`} {
		if strings.Contains(string(blob), banned) {
			t.Fatalf("响应里出现了 %q：%s", banned, blob)
		}
	}
	if !list[0].SecretConfigured {
		t.Fatal("配了凭据的账号应当 secret_configured = true")
	}

	var before string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT encode(secret_cipher, 'hex') FROM mail_accounts WHERE id = $1::bigint", acct.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	limit := 7
	if _, err := h.svc.UpdateAccount(h.ctx, h.adminActor(), acct.PublicID, mail.AccountPatch{DailyLimit: &limit}); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT encode(secret_cipher, 'hex') FROM mail_accounts WHERE id = $1::bigint", acct.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("不带 secret 的 PATCH 改动了密文: %s → %s", before, after)
	}

	newSecret := json.RawMessage(`{"api_key":"rotated-value"}`)
	if _, err := h.svc.UpdateAccount(h.ctx, h.adminActor(), acct.PublicID, mail.AccountPatch{Secret: newSecret}); err != nil {
		t.Fatal(err)
	}
	var rotated string
	var updatedAt *time.Time
	if err := h.pool.QueryRow(h.ctx,
		"SELECT encode(secret_cipher, 'hex'), secret_updated_at FROM mail_accounts WHERE id = $1::bigint",
		acct.ID).Scan(&rotated, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if rotated == after {
		t.Fatal("轮换凭据之后密文没变")
	}
	if updatedAt == nil {
		t.Fatal("轮换凭据之后 secret_updated_at 必须非空")
	}
}

func TestDeleteArchivesReferencedAccount(t *testing.T) {
	h := newHarness(t)
	acct := h.newAccount("main", "log", 10, 5, `{"api_key":"k"}`, "")

	res, err := h.svc.DeleteAccount(h.ctx, h.adminActor(), acct.PublicID)
	if err != nil {
		t.Fatal(err)
	}
	if res.Archived {
		t.Fatal("没有任何投递记录的账号应当硬删")
	}
	var n int
	if err := h.pool.QueryRow(h.ctx, "SELECT count(*) FROM mail_accounts WHERE id = $1::bigint", acct.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("硬删之后不该还有行")
	}

	// 发过信的账号：归档（发信历史是证据，d6 §6.10）
	acct2 := h.newAccount("used", "log", 10, 5, `{"api_key":"k"}`, "")
	logID := h.enqueue(mail.EnqueueInput{
		RecipientID: 1, ToAddress: "u@example.com",
		Template: mail.TemplateVerifyEmail, Data: pgmail.Data{Code: "123456"},
	})
	if err := h.svc.HandleMailSend(h.ctx, h.payload(logID)); err != nil {
		t.Fatal(err)
	}
	res, err = h.svc.DeleteAccount(h.ctx, h.adminActor(), acct2.PublicID)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Archived {
		t.Fatal("被 mail_logs 引用过的账号应当归档而不是硬删")
	}
	var archived *time.Time
	var enabled bool
	if err := h.pool.QueryRow(h.ctx,
		"SELECT archived_at, enabled FROM mail_accounts WHERE id = $1::bigint", acct2.ID).Scan(&archived, &enabled); err != nil {
		t.Fatal(err)
	}
	if archived == nil || enabled {
		t.Fatalf("归档后 archived_at = %v, enabled = %v，想要非空与 false", archived, enabled)
	}
	if ok, _ := h.svc.HasUsable(h.ctx); ok {
		t.Fatal("只剩归档账号时 HasUsable 应为 false")
	}
}

func TestSendVerifyCodeCreatesPendingLog(t *testing.T) {
	h := newHarness(t)
	id, err := h.svc.SendVerifyCode(h.ctx, 7, "u@example.com", "654321", mail.TemplateVerifyEmail)
	if err != nil {
		t.Fatal(err)
	}
	row := h.log(id)
	if row.Template != mail.TemplateVerifyEmail || row.Status != "pending" || row.To != "u@example.com" {
		t.Fatalf("验证码投递记录不对: %+v", row)
	}
	if !strings.Contains(row.Payload, "654321") {
		t.Fatalf("payload 里应当有验证码: %s", row.Payload)
	}
	again, err := h.svc.SendVerifyCode(h.ctx, 7, "u@example.com", "654321", mail.TemplateVerifyEmail)
	if err != nil {
		t.Fatal(err)
	}
	if again != id {
		t.Fatalf("同码重复提交建了第二条记录: %d vs %d", again, id)
	}
	fresh, err := h.svc.SendVerifyCode(h.ctx, 7, "u@example.com", "999999", mail.TemplateVerifyEmail)
	if err != nil {
		t.Fatal(err)
	}
	if fresh == id {
		t.Fatal("重新生成的验证码应当是新的投递记录")
	}
}

// TestTemplatesMatchCheckAndFiles：模板常量 == 平台模板文件 == 迁移里的 CHECK 值域（d6 §10 第 49 条）。
func TestTemplatesMatchCheckAndFiles(t *testing.T) {
	h := newHarness(t)
	got := []string{mail.TemplateVerifyEmail, mail.TemplateResetPassword, mail.TemplateTest, mail.TemplateNotice}
	seen := map[string]bool{}
	for _, tpl := range got {
		if seen[tpl] {
			t.Fatalf("模板常量重复: %s", tpl)
		}
		seen[tpl] = true
		// 1) 平台能渲染 → 模板文件在（缺文件/缺字段都会在 Render 里报错）
		if _, err := pgmail.Render(tpl, pgmail.Data{Code: "123456", Title: "标题"}); err != nil {
			t.Fatalf("渲染模板 %s: %v", tpl, err)
		}
		// 2) CHECK 允许这个值
		if _, err := h.pool.Exec(h.ctx, `INSERT INTO mail_logs (idempotency_key, to_address, template)
		         VALUES ($1::varchar, 'x@example.com', $2::varchar)`, "tpl:"+tpl, tpl); err != nil {
			t.Fatalf("CHECK 不接受模板 %s: %v", tpl, err)
		}
	}
	// 3) 反查值域：CHECK 里出现的值必须正好是这四个（多了说明常量漏了一个）
	var def string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_mail_logs_template'").Scan(&def); err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile(`'([a-z_]+)'::`).FindAllStringSubmatch(def, -1)
	for _, m := range matches {
		if !seen[m[1]] {
			t.Fatalf("CHECK 里还有模板 %q，但本模块没有对应常量：%s", m[1], def)
		}
	}
	if len(matches) != len(got) {
		t.Fatalf("CHECK 值域有 %d 个，本模块常量 %d 个：%s", len(matches), len(got), def)
	}
	// 4) 反例：不在值域里的模板必须被挡（证明第 2 步真的在验值域）
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO mail_logs (idempotency_key, to_address, template)
	         VALUES ('tpl:bogus', 'x@example.com', 'bogus')`); err == nil {
		t.Fatal("CHECK 没挡住未知模板")
	}
}

package auth

// 管理端用户读路径的用例（交接单 C1）。**先确认会红**：
// 路由不存在时 gin 直接 panic（"no route registered"）——第一条用例就把「端点不存在」摆出来。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// newAdminRouter 起一个真路由：真 handler + 真中间件（与 app 层 /admin 段的挂法一致）。
func (f *fixture) newAdminRouter() *gin.Engine {
	f.t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	NewHandler(f.svc).Register(r.Group("/api/v1"))
	return r
}

func (f *fixture) doJSON(r *gin.Engine, method, path, cookie, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: f.cfg.Site.CookieName, Value: cookie})
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// listData 解 {"data":[...],"next_cursor":...}。
func listData[T any](t *testing.T, w *httptest.ResponseRecorder) ([]T, *string) {
	t.Helper()
	var env struct {
		Data       []T     `json:"data"`
		NextCursor *string `json:"next_cursor"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应不是 {data,next_cursor}：%s", w.Body.String())
	}
	return env.Data, env.NextCursor
}

func (f *fixture) actorFor(userID int64, roleKey string) *authz.Actor {
	f.t.Helper()
	return &authz.Actor{UserID: userID, RoleID: f.roleID(roleKey), Perms: authz.NewSet()}
}

func (f *fixture) userIDOf(t *testing.T, username string) int64 {
	t.Helper()
	var id int64
	if err := f.pool.QueryRow(f.ctx, "SELECT id FROM users WHERE username = $1", username).Scan(&id); err != nil {
		t.Fatalf("取用户 %s 失败: %v", username, err)
	}
	return id
}

// ── 会红的那条 ────────────────────────────────────────────────────

// 没有 user.ban 的人读用户列表必须 403；游客 401。
// 这条同时证明路由真的挂上了：路由不存在时 gin 会 panic。
func TestAdminUsersListGuards(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("alice", "pw-alice-1", "user")
	r := f.newAdminRouter()

	if w := f.doJSON(r, "GET", "/api/v1/admin/users", "", ""); w.Code != 401 {
		t.Fatalf("游客必须是 401，实际 %d：%s", w.Code, w.Body.String())
	}

	tok := f.login("alice", "pw-alice-1")
	w := f.doJSON(r, "GET", "/api/v1/admin/users", tok, "")
	if w.Code != 403 {
		t.Fatalf("没有 user.ban 必须是 403，实际 %d：%s", w.Code, w.Body.String())
	}
	if code := errCodeOfBody(t, w.Body.Bytes()); code != apperr.CodeForbidden {
		t.Fatalf("错误码应当是 %s，实际 %s", apperr.CodeForbidden, code)
	}
}

// service 层的守卫（不经 HTTP）。
func TestAdminUsersServiceGuards(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	plainID := f.newUser("plain", "pw-plain-1", "user")
	plain := f.actorFor(plainID, "user")

	if _, _, err := f.svc.ListAdminUsers(f.ctx, plain, AdminUsersQuery{}); err == nil {
		t.Fatal("没有 user.ban 必须被拒")
	}
	if _, err := f.svc.AdminUserDetail(f.ctx, plain, "00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("没有 user.ban 必须被拒")
	}
	if _, err := f.svc.AdminUserDetail(f.ctx, nil, "x"); err == nil {
		t.Fatal("游客必须被拒")
	}
}

// ── 筛选与分页 ────────────────────────────────────────────────────

// seedUsers 种四个人，覆盖三根状态轴与两个角色。返回 admin 身份。
//
//	root2: admin 角色，验证 + 激活
//	alice: user 角色，验证 + 激活，status=banned
//	bob:   creator 角色，验证 + 激活
//	carol: user 角色，**邮箱未验证 + 未激活**
func seedUsers(t *testing.T, f *fixture) *authz.Actor {
	t.Helper()
	f.seedRBAC()
	adminID := f.newUser("root2", "pw-root2-1", "admin")
	f.newUser("alice", "pw-alice-1", "user")
	f.newUser("bob", "pw-bob-1", "creator")
	f.newUserRow("carol", "pw-carol-1", "user", false)
	_ = adminID
	mustExec(t, f.ctx, f.pool, "UPDATE users SET status = 'banned' WHERE username = 'alice'")
	mustExec(t, f.ctx, f.pool, "UPDATE users SET email_verified_at = NULL WHERE username = 'carol'")
	// 身份走**真登录 + 真权限闭包**（不是手搓 Perms）：这样顺带证明 user.ban 真的挂在
	// admin 角色上（seedRBAC 的勾选矩阵照 0017_seed_authz 抄）。
	return f.actor(f.login("root2", "pw-root2-1"))
}

func namesOf(users []AdminUserDTO) map[string]AdminUserDTO {
	out := make(map[string]AdminUserDTO, len(users))
	for _, u := range users {
		out[u.Username] = u
	}
	return out
}

func TestListAdminUsersFilters(t *testing.T) {
	f := newFixture(t)
	admin := seedUsers(t, f)

	all, next, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("不带筛选应当有 4 个人，实际 %d", len(all))
	}
	if next != "" {
		t.Fatalf("一页装得下时不该给下一页游标，实际 %q", next)
	}
	// 按 id DESC（uuid v7 时间有序）= 新注册的在最前
	if all[0].Username != "carol" {
		t.Fatalf("最新注册的 carol 应当排在最前，实际 %s", all[0].Username)
	}
	// 三根状态轴不合并：carol 邮箱没过但状态仍是 active
	if carol := namesOf(all)["carol"]; carol.Status != StatusActive || carol.EmailVerifiedAt != nil || carol.ActivatedAt != nil {
		t.Fatalf("carol 的三根轴不对: %+v", carol)
	}
	// 角色是 key/name/badge_color 三元组
	if alice := namesOf(all)["alice"]; alice.Role.Key != "user" || alice.Role.Name == "" {
		t.Fatalf("alice 的角色不对: %+v", alice.Role)
	}

	cases := []struct {
		name string
		q    AdminUsersQuery
		want []string
	}{
		{"status=banned", AdminUsersQuery{Status: StatusBanned}, []string{"alice"}},
		{"role=creator", AdminUsersQuery{Role: "creator"}, []string{"bob"}},
		{"email_verified=false", AdminUsersQuery{EmailVerified: boolPtr(false)}, []string{"carol"}},
		{"activated=false", AdminUsersQuery{Activated: boolPtr(false)}, []string{"carol"}},
		{"activated=true", AdminUsersQuery{Activated: boolPtr(true)}, []string{"root2", "bob", "alice"}},
		{"q=alice（登录名）", AdminUsersQuery{Q: "alice"}, []string{"alice"}},
		{"q=@example（邮箱）", AdminUsersQuery{Q: "@example.com"}, []string{"root2", "carol", "bob", "alice"}},
		{"组合 status+role", AdminUsersQuery{Status: StatusActive, Role: "user"}, []string{"carol"}},
	}
	for _, c := range cases {
		got, _, err := f.svc.ListAdminUsers(f.ctx, admin, c.q)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("%s: 期望 %d 条 %v，实际 %d 条 %s", c.name, len(c.want), c.want, len(got), keysOf(namesOf(got)))
		}
		byName := namesOf(got)
		for _, w := range c.want {
			if _, ok := byName[w]; !ok {
				t.Fatalf("%s: 少了 %s（实际 %v）", c.name, w, keysOf(byName))
			}
		}
	}

	// 非法 status 是 400 而不是「静默返回空」
	if _, _, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{Status: "zzz"}); err == nil {
		t.Fatal("非法 status 必须报参数错误")
	}
}

func keysOf(m map[string]AdminUserDTO) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func boolPtr(v bool) *bool { return &v }

// 游标分页不能漏人、不能重复（照 notify 那两条「并列时刻」用例的写法）。
func TestListAdminUsersCursorHasNoGapsOrDupes(t *testing.T) {
	f := newFixture(t)
	admin := seedUsers(t, f)

	seen := map[string]int{}
	cursor := ""
	for page := 0; page < 6; page++ {
		users, next, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		if len(users) == 0 {
			t.Fatalf("第 %d 页为空但还没走完", page)
		}
		for _, u := range users {
			seen[u.Username]++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != 4 {
		t.Fatalf("翻页应当看到 4 个人，实际 %v", seen)
	}
	for name, n := range seen {
		if n != 1 {
			t.Fatalf("%s 出现了 %d 次（分页漏人或重复）", name, n)
		}
	}
	if _, _, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{Cursor: "not-a-cursor"}); err == nil {
		t.Fatal("伪造的游标必须是 400，不能静默当成第一页")
	}
}

// ── 详情：三张关联表 ──────────────────────────────────────────────

func TestAdminUserDetailCarriesSanctionsGrantsTitles(t *testing.T) {
	f := newFixture(t)
	admin := seedUsers(t, f)
	aliceID := f.userIDOf(t, "alice")
	rootID := f.userIDOf(t, "root2")

	// 一条全站处罚 + 一条分区处罚（分区表建一行最小的：slug 唯一）
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO sanctions (user_id, board_id, action, reason, until) VALUES ($1, NULL, 'all', '刷屏推广', NULL)", aliceID)
	var boardID int64
	if err := f.pool.QueryRow(f.ctx,
		"INSERT INTO boards (slug, name) VALUES ('campaign', '自制战役') RETURNING id").Scan(&boardID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO sanctions (user_id, board_id, action, reason) VALUES ($1, $2, 'reply', '在资源帖下争吵')", aliceID, boardID)

	// 一条追加权限
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO user_permissions (user_id, permission_id, granted_by, reason, expires_at) "+
			"SELECT $1, p.id, $2, '临时代管审核队列', now() + interval '7 days' FROM permissions p WHERE p.key = $3",
		aliceID, rootID, authz.PermPostReview)
	// 一个头衔
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO titles (public_id, key, name, color, description) VALUES (gen_random_uuid(), 'veteran', '元老', '#f97316', '旧站创始成员')")
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO user_titles (user_id, title_id, granted_by) SELECT $1, t.id, $2 FROM titles t WHERE t.key = 'veteran'",
		aliceID, rootID)

	var alicePublicID string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE id = $1", aliceID).Scan(&alicePublicID); err != nil {
		t.Fatal(err)
	}
	d, err := f.svc.AdminUserDetail(f.ctx, admin, alicePublicID)
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != alicePublicID || d.Username != "alice" || d.Status != StatusBanned {
		t.Fatalf("详情的基本字段不对: %+v", d)
	}
	if len(d.Sanctions) != 2 {
		t.Fatalf("应当有 2 条处罚，实际 %d", len(d.Sanctions))
	}
	// 两条处罚是**同一时刻**写进去的（同一个事务外的 now()），所以断言按内容找，
	// 不按数组下标 —— 排序键是 (未过期 DESC, created_at DESC, id DESC)，两条同刻时下标由 id 决定。
	var global, scoped *AdminSanctionDTO
	for i := range d.Sanctions {
		if d.Sanctions[i].Board == nil {
			global = &d.Sanctions[i]
		} else {
			scoped = &d.Sanctions[i]
		}
	}
	if global == nil {
		t.Fatalf("全站处罚的 board 应当是 null: %+v", d.Sanctions)
	}
	if global.Until != nil || global.Reason != "刷屏推广" || global.Action != "all" {
		t.Fatalf("永久全站处罚的形状不对: %+v", global)
	}
	if scoped == nil || scoped.Board.Slug != "campaign" || scoped.Board.Name != "自制战役" || scoped.Action != "reply" {
		t.Fatalf("分区处罚没有带出分区: %+v", d.Sanctions)
	}
	if len(d.UserPermissions) != 1 || d.UserPermissions[0].Key != authz.PermPostReview {
		t.Fatalf("user_permissions 不对: %+v", d.UserPermissions)
	}
	if d.UserPermissions[0].Reason == "" || d.UserPermissions[0].ExpiresAt == nil {
		t.Fatalf("追加权限必须带 reason 与 expires_at: %+v", d.UserPermissions[0])
	}
	if len(d.UserTitles) != 1 || d.UserTitles[0].Key != "veteran" || d.UserTitles[0].Color != "#f97316" {
		t.Fatalf("user_titles 不对: %+v", d.UserTitles)
	}
	if d.UserTitles[0].ID == "" {
		t.Fatal("头衔要带 public_id（前端要拿它去 DELETE）")
	}

	// 不存在的用户 → 同一个 404；非 uuid 也走同一条（不查库）
	if _, err := f.svc.AdminUserDetail(f.ctx, admin, "00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("不存在的用户必须报错")
	}
	if _, err := f.svc.AdminUserDetail(f.ctx, admin, "not-a-uuid"); err == nil {
		t.Fatal("非 uuid 必须报错")
	}
}

// 没有内容的用户计数是 0 而不是 null；有内容的用户计数要准（两个 JOIN 的口径）。
func TestAdminUsersContentCounts(t *testing.T) {
	f := newFixture(t)
	admin := seedUsers(t, f)
	aliceID := f.userIDOf(t, "alice")

	var boardID int64
	if err := f.pool.QueryRow(f.ctx,
		"INSERT INTO boards (slug, name) VALUES ('b', 'B') RETURNING id").Scan(&boardID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO topics (public_id, board_id, author_id, kind, title, excerpt, client_token, last_reply_at) "+
			"VALUES (gen_random_uuid(), $1, $2, 'discussion', 't1', 'x', gen_random_uuid(), now())", boardID, aliceID)
	var topicID int64
	if err := f.pool.QueryRow(f.ctx, "SELECT id FROM topics WHERE author_id = $1", aliceID).Scan(&topicID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html) "+
			"VALUES (gen_random_uuid(), $1, $2, 1, 'x', '<p>x</p>')", topicID, aliceID)

	users, _, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{Q: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 {
		t.Fatalf("应当只有 alice，实际 %d", len(users))
	}
	if users[0].TopicCount != 1 || users[0].ReplyCount != 1 {
		t.Fatalf("alice 的计数应当是 1/1，实际 %d/%d", users[0].TopicCount, users[0].ReplyCount)
	}
	if bob := namesOf(mustList(t, f, admin, "bob"))["bob"]; bob.TopicCount != 0 || bob.ReplyCount != 0 {
		t.Fatalf("没有内容的 bob 计数应当是 0/0，实际 %d/%d", bob.TopicCount, bob.ReplyCount)
	}
}

func mustList(t *testing.T, f *fixture, admin *authz.Actor, q string) []AdminUserDTO {
	t.Helper()
	users, _, err := f.svc.ListAdminUsers(f.ctx, admin, AdminUsersQuery{Q: q})
	if err != nil {
		t.Fatal(err)
	}
	return users
}

// HTTP 层：包络是 {data,next_cursor}，字段名逐条对照 DTO。
func TestAdminUsersHTTPEnvelope(t *testing.T) {
	f := newFixture(t)
	seedUsers(t, f)
	r := f.newAdminRouter()
	tok := f.login("root2", "pw-root2-1")

	w := f.doJSON(r, "GET", "/api/v1/admin/users?limit=2", tok, "")
	if w.Code != 200 {
		t.Fatalf("管理员的列表应当 200，实际 %d：%s", w.Code, w.Body.String())
	}
	users, next := listData[AdminUserDTO](t, w)
	if len(users) != 2 {
		t.Fatalf("limit=2 应当给 2 条，实际 %d", len(users))
	}
	if next == nil || *next == "" {
		t.Fatal("还有下一页时 next_cursor 不能是 null")
	}
	// 字段名是契约：少一个前端就渲染不出来
	var raw map[string]any
	if err := json.Unmarshal(mustFirst(t, w), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"id", "username", "nickname", "email", "role", "status",
		"email_verified_at", "activated_at", "trusted", "level", "created_at", "last_login_at",
		"topic_count", "reply_count"} {
		if _, ok := raw[k]; !ok {
			t.Fatalf("用户行少了字段 %s：%s", k, string(mustFirst(t, w)))
		}
	}

	// 第二页接得上
	w2 := f.doJSON(r, "GET", "/api/v1/admin/users?limit=2&cursor="+*next, tok, "")
	if w2.Code != 200 {
		t.Fatalf("第二页应当 200，实际 %d：%s", w2.Code, w2.Body.String())
	}
	page2, _ := listData[AdminUserDTO](t, w2)
	if len(page2) != 2 {
		t.Fatalf("第二页应当 2 条，实际 %d", len(page2))
	}
	if page2[0].Username == users[0].Username || page2[0].Username == users[1].Username {
		t.Fatal("第二页与第一页有重复")
	}
}

func mustFirst(t *testing.T, w *httptest.ResponseRecorder) []byte {
	t.Helper()
	var env struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应不是 {data:[...]}：%s", w.Body.String())
	}
	if len(env.Data) == 0 {
		t.Fatalf("data 是空的：%s", w.Body.String())
	}
	return env.Data[0]
}

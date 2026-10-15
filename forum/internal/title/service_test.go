package title

import (
	"errors"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

func TestGrantEquipRevoke(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	tt := f.createTitle(t, "founder", "创始人")

	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: tt.ID}); err != nil {
		t.Fatal(err)
	}
	// 重复授予：幂等成功，仍然一行
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: tt.ID}); err != nil {
		t.Fatalf("重复授予必须幂等成功，实际 %v", err)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM user_titles WHERE user_id = $1", u); n != 1 {
		t.Fatalf("user_titles 该只有一行，实际 %d", n)
	}

	if err := f.svc.Equip(f.ctx, f.plain(u), tt.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.UserTitles(f.ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if got.EquippedID != tt.ID {
		t.Fatalf("佩戴后 equipped_id 该是 %s，实际 %q", tt.ID, got.EquippedID)
	}

	// 收回：行没了，且**佩戴被同事务清空**
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: tt.ID, Revoke: true}); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM user_titles WHERE user_id = $1", u); n != 0 {
		t.Fatalf("收回后不该还有持有行，实际 %d", n)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM users WHERE id = $1 AND equipped_title_id IS NULL", u); n != 1 {
		t.Fatal("收回的正是佩戴项时必须同事务清空 equipped_title_id")
	}
	// 重复收回：0 行、不报错
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: tt.ID, Revoke: true}); err != nil {
		t.Fatalf("重复收回必须幂等，实际 %v", err)
	}

	// 审计：授予 + 收回各一条，Equip 不写
	actions := f.audit.actions()
	want := map[string]int{ActionTitleGrant: 2, ActionTitleRevoke: 2, ActionTitleManage: 1}
	for action, n := range want {
		got := 0
		for _, a := range actions {
			if a == action {
				got++
			}
		}
		if got != n {
			t.Fatalf("审计 %s 该有 %d 条，实际 %d（全部：%v）", action, n, got, actions)
		}
	}
}

func TestEquipRejectsUnheldAndArchived(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	held := f.createTitle(t, "founder", "创始人")
	other := f.createTitle(t, "veteran", "老兵")

	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: held.ID}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Equip(f.ctx, f.plain(u), other.ID); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("佩戴没持有的头衔必须 403，实际 %v", err)
	}
	if err := f.svc.Equip(f.ctx, f.plain(u), "not-a-uuid"); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("坏 id 等同没持有 → 403，实际 %v", err)
	}

	// 归档后不能新佩戴（但已佩戴的保留）
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: other.ID}); err != nil {
		t.Fatal(err)
	}
	archived, err := f.svc.UpdateTitle(f.ctx, f.admin(), TitleInput{PublicID: other.ID, Name: "老兵", Archived: true})
	if err != nil {
		t.Fatal(err)
	}
	if archived.ArchivedAt == nil {
		t.Fatal("归档时间必须写进去")
	}
	if err := f.svc.Equip(f.ctx, f.plain(u), other.ID); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("佩戴已归档的头衔必须 400，实际 %v", err)
	}

	// 取消佩戴：没有佩戴时也是幂等成功
	if err := f.svc.Equip(f.ctx, f.plain(u), held.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Equip(f.ctx, f.plain(u), ""); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.UserTitles(f.ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if got.EquippedID != "" {
		t.Fatalf("取消佩戴后 equipped_id 该为空，实际 %q", got.EquippedID)
	}
	if err := f.svc.Equip(f.ctx, f.plain(u), ""); err != nil {
		t.Fatalf("重复取消佩戴必须幂等，实际 %v", err)
	}
}

// 归档只影响目录与新佩戴：已持有的人仍带着徽章（历史事实）。
func TestArchiveHidesFromCatalogButKeepsHeld(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	keep := f.createTitle(t, "founder", "创始人")
	gone := f.createTitle(t, "veteran", "老兵")
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: gone.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.UpdateTitle(f.ctx, f.admin(), TitleInput{PublicID: gone.ID, Name: "老兵", Archived: true}); err != nil {
		t.Fatal(err)
	}

	list, err := f.svc.ListTitles(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != keep.ID {
		t.Fatalf("目录不该返回归档的头衔，实际 %+v", list)
	}
	held, err := f.svc.UserTitles(f.ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if len(held.Items) != 1 || held.Items[0].ID != gone.ID || held.Items[0].ArchivedAt == nil {
		t.Fatalf("已持有的归档头衔仍该出现在用户页，实际 %+v", held.Items)
	}
}

func TestCreateTitleValidatesAndConflicts(t *testing.T) {
	f := newFixture(t)
	f.createTitle(t, "founder", "创始人")

	if _, err := f.svc.CreateTitle(f.ctx, f.admin(), TitleInput{Key: "founder", Name: "另一个"}); !isCode(err, apperr.CodeConflict) {
		t.Fatalf("重复 key 必须 409，实际 %v", err)
	}
	bad := []TitleInput{
		{Key: "Founder", Name: "x"}, // 大写
		{Key: "", Name: "x"},        // 空 key
		{Key: "ok_key", Name: "  "}, // 空名字
		{Key: "ok_key2", Name: "x", Color: "blue"},
		{Key: "ok_key3", Name: "x", Description: string(make([]rune, 201))},
	}
	for _, in := range bad {
		if _, err := f.svc.CreateTitle(f.ctx, f.admin(), in); !isCode(err, apperr.CodeInvalidInput) {
			t.Fatalf("%+v 必须 400，实际 %v", in, err)
		}
	}
	if _, err := f.svc.UpdateTitle(f.ctx, f.admin(), TitleInput{PublicID: "not-a-uuid", Name: "x"}); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("改不存在的头衔必须 404，实际 %v", err)
	}
}

// 无权限：路由中间件与 service 层各拦一次，这里测 service 层（d4 §8.3）。
func TestTitleWritesRequirePermission(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	tt := f.createTitle(t, "founder", "创始人")
	noPerm := f.plain(u)

	if err := f.svc.AssignTitle(f.ctx, noPerm, AssignInput{UserID: u, TitlePublicID: tt.ID}); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("无 title.grant 授予必须 403，实际 %v", err)
	}
	if _, err := f.svc.CreateTitle(f.ctx, noPerm, TitleInput{Key: "x", Name: "x"}); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("无 title.manage 建头衔必须 403，实际 %v", err)
	}
	if _, err := f.svc.UpdateTitle(f.ctx, noPerm, TitleInput{PublicID: tt.ID, Name: "x"}); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("无 title.manage 改头衔必须 403，实际 %v", err)
	}
	if _, err := f.svc.AddExp(f.ctx, noPerm, AddExpInput{UserID: u, Delta: 10, Reason: ReasonManual}); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("无权限加经验必须 403，实际 %v", err)
	}
	// 超管短路：permissions 集合为空也放行
	super := &authz.Actor{UserID: f.adminID, IsSuper: true}
	if err := f.svc.AssignTitle(f.ctx, super, AssignInput{UserID: u, TitlePublicID: tt.ID}); err != nil {
		t.Fatalf("超管必须放行，实际 %v", err)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM user_titles"); n != 1 {
		t.Fatalf("被拒的授予不该留下行，实际 %d", n)
	}
}

func TestLevelForExpAndSQLAgree(t *testing.T) {
	cases := []struct {
		exp   int
		level int
	}{
		{0, 1}, {99, 1}, {100, 2}, {400, 3}, {900, 4}, {10000, 11},
	}
	for _, c := range cases {
		if got := LevelForExp(c.exp); got != c.level {
			t.Fatalf("LevelForExp(%d) = %d，期望 %d", c.exp, got, c.level)
		}
	}

	// 同一批数字走一遍 SQL，两边必须一致（d4 §8.3 的「等级不变量」）
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	for _, c := range cases {
		if _, err := f.pool.Exec(f.ctx, "UPDATE users SET exp = $2::int, level = floor(sqrt($2::int / 100.0))::int + 1 WHERE id = $1", u, c.exp); err != nil {
			t.Fatal(err)
		}
		var level int
		if err := f.pool.QueryRow(f.ctx, "SELECT level FROM users WHERE id = $1", u).Scan(&level); err != nil {
			t.Fatal(err)
		}
		if level != LevelForExp(c.exp) {
			t.Fatalf("exp=%d 时 SQL 算出 level=%d，Go 算出 %d", c.exp, level, LevelForExp(c.exp))
		}
	}
}

func TestAddExpIsIdempotentByRef(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")

	out, err := f.svc.AddExp(f.ctx, f.admin(), AddExpInput{UserID: u, Delta: 100, Reason: ReasonTopic, Ref: "topic:1"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Exp != 100 || out.Level != 2 {
		t.Fatalf("第一次该是 exp=100/level=2，实际 %+v", out)
	}
	// 同一个 ref：不再加，返回当前值
	out, err = f.svc.AddExp(f.ctx, f.admin(), AddExpInput{UserID: u, Delta: 100, Reason: ReasonTopic, Ref: "topic:1"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Exp != 100 || out.Level != 2 {
		t.Fatalf("重放不该再加经验，实际 %+v", out)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM exp_events WHERE user_id = $1", u); n != 1 {
		t.Fatalf("流水该只有一行，实际 %d", n)
	}
	// 换一个 ref：加
	out, err = f.svc.AddExp(f.ctx, f.admin(), AddExpInput{UserID: u, Delta: 100, Reason: ReasonTopic, Ref: "topic:2"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Exp != 200 || out.Level != 2 {
		t.Fatalf("第二次该是 exp=200/level=2，实际 %+v", out)
	}
	// 空 ref：不去重（每次都加）
	for i := 0; i < 2; i++ {
		if _, err := f.svc.AddExp(f.ctx, f.admin(), AddExpInput{UserID: u, Delta: 300, Reason: ReasonManual}); err != nil {
			t.Fatal(err)
		}
	}
	if out, _ := f.svc.AddExp(f.ctx, f.admin(), AddExpInput{UserID: u, Delta: 1, Reason: ReasonManual}); out.Exp != 801 {
		t.Fatalf("空 ref 的加经验不该去重，实际 %+v", out)
	}
	// exp 与流水之和一致（自检第 3 条）
	if n := countRows(t, f.ctx, f.pool, `
SELECT count(*) FROM users u
 WHERE u.exp <> COALESCE((SELECT sum(e.delta) FROM exp_events e WHERE e.user_id = u.id), 0)`); n != 0 {
		t.Fatalf("有 %d 个用户的 exp 与流水之和对不上", n)
	}

	for _, bad := range []AddExpInput{
		{UserID: u, Delta: 0, Reason: ReasonManual},
		{UserID: u, Delta: 5, Reason: "nonsense"},
		{UserID: u, Delta: 5, Reason: ReasonTopic, Ref: "not a ref"},
	} {
		if _, err := f.svc.AddExp(f.ctx, f.admin(), bad); !isCode(err, apperr.CodeInvalidInput) {
			t.Fatalf("%+v 必须 400，实际 %v", bad, err)
		}
	}
}

// 并发佩戴：最终只会有一个（唯一性由 users 的一个可空外键天然保证）。
func TestConcurrentEquipLeavesExactlyOne(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	t1 := f.createTitle(t, "founder", "创始人")
	t2 := f.createTitle(t, "veteran", "老兵")
	for _, id := range []string{t1.ID, t2.ID} {
		if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: id}); err != nil {
			t.Fatal(err)
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := t1.ID
			if i%2 == 1 {
				id = t2.ID
			}
			if err := f.svc.Equip(f.ctx, f.plain(u), id); err != nil {
				t.Errorf("equip: %v", err)
			}
		}(i)
	}
	wg.Wait()

	var equipped *string
	if err := f.pool.QueryRow(f.ctx, `
SELECT t.public_id::text FROM users u
  JOIN titles t ON t.id = u.equipped_title_id
 WHERE u.id = $1`, u).Scan(&equipped); err != nil {
		t.Fatal(err)
	}
	if equipped == nil || (*equipped != t1.ID && *equipped != t2.ID) {
		t.Fatalf("最终佩戴的必须是其中一个，实际 %v", equipped)
	}
	// 自检第 2 条：佩戴的必须真的持有
	if n := countRows(t, f.ctx, f.pool, `
SELECT count(*) FROM users u
 WHERE u.equipped_title_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM user_titles ut WHERE ut.user_id = u.id AND ut.title_id = u.equipped_title_id)`); n != 0 {
		t.Fatalf("有 %d 个用户戴着没持有的头衔", n)
	}
}

// D68（2026-10-15 用户实测「归档头衔管理屏看不到、key 被占用变永久卡死」）的两条根：
// ① 管理目录要能看到归档项（旧 adminList 复用了不返归档的 ListTitles），否则「恢复 / 删除」都无从谈起；
// ② 真删除在被引用时明确 409（说清多少人在持有 / 佩戴），不级联毁掉 user_titles 的历史行。
func TestAdminListIncludesArchived(t *testing.T) {
	f := newFixture(t)
	keep := f.createTitle(t, "founder", "创始人")
	gone := f.createTitle(t, "veteran", "老兵")
	if _, err := f.svc.UpdateTitle(f.ctx, f.admin(), TitleInput{PublicID: gone.ID, Name: "老兵", Archived: true}); err != nil {
		t.Fatal(err)
	}

	// 公共目录照旧不返归档（TestArchiveHidesFromCatalogButKeepsHeld 已钉）；管理目录两行都要在
	list, err := f.svc.AdminListTitles(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("管理目录应看到全部 2 条（含归档），实际 %d", len(list))
	}
	byKey := map[string]*TitleDTO{}
	for i := range list {
		byKey[list[i].Key] = &list[i]
	}
	if byKey[keep.Key] == nil || byKey[gone.Key] == nil {
		t.Fatalf("管理目录缺行: %+v", list)
	}
	if byKey[gone.Key].ArchivedAt == nil {
		t.Fatalf("归档行必须带着 archived_at: %+v", byKey[gone.Key])
	}
}

func TestDeleteTitleRefusesWhileReferenced(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	held := f.createTitle(t, "veteran", "老兵")
	free := f.createTitle(t, "free", "自由")

	// ① 未被引用：删得掉，且审计留一条（现在已有的 create×2 + update×1 都算）
	if err := f.svc.DeleteTitle(f.ctx, f.admin(), free.ID); err != nil {
		t.Fatalf("无人引用的头衔应当真删成功: %v", err)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM titles WHERE public_id = $1", free.ID); n != 0 {
		t.Fatal("删除必须物化：titles 里不该再有这一行")
	}
	if ents := f.audit.entries; len(ents) < 3 {
		t.Fatalf("删除应写一条审计，动作应不少于 create×2 + delete: %v", f.audit.actions())
	} else if ents[len(ents)-1].TargetID != free.ID || ents[len(ents)-1].Detail["deleted"] != true {
		t.Fatalf("最后一条审计应是删除本身（含 deleted 标记）: %+v", ents[len(ents)-1])
	}

	// ② 已被持有（还没佩戴）：409 说不清谁挂着就不许删
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: held.ID}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteTitle(f.ctx, f.admin(), held.ID); !isCode(err, apperr.CodeConflict) {
		t.Fatalf("被持有的头衔删除必须 409，实际 %v", err)
	}
	if n := countRows(t, f.ctx, f.pool, "SELECT count(*) FROM user_titles WHERE user_id = $1", u); n != 1 {
		t.Fatalf("409 不得级联毁持有行: %d", n)
	}

	// ③ 佩戴中的更要挡（外键 SET NULL 会白手抹掉用户的选择）
	if err := f.svc.Equip(f.ctx, f.plain(u), held.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteTitle(f.ctx, f.admin(), held.ID); !isCode(err, apperr.CodeConflict) {
		t.Fatalf("佩戴中的头衔删除必须 409，实际 %v", err)
	}

	// ④ 已经没人持有（收回后）：删得掉
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: held.ID, Revoke: true}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteTitle(f.ctx, f.admin(), held.ID); err != nil {
		t.Fatalf("收回佩戴 / 持有后应当能真删: %v", err)
	}

	// ⑤ 权限与存在性：无 title.manage 403；不存在的 id 404（坏形状不给 500）
	if err := f.svc.DeleteTitle(f.ctx, f.plain(u), held.ID); !isCode(err, apperr.CodeForbidden) {
		t.Fatalf("无权限删除必须 403，实际 %v", err)
	}
	if err := f.svc.DeleteTitle(f.ctx, f.admin(), "not-a-uuid"); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("不存在的 id 必须 404，实际 %v", err)
	}
}

func TestAuditFailurePropagates(t *testing.T) {
	f := newFixture(t)
	u := newUser(t, f.ctx, f.pool, "alice")
	tt := f.createTitle(t, "founder", "创始人")
	f.audit.err = errors.New("audit down")

	// 授予已经提交，但审计写不进去必须让调用方看见（不能静默丢审计）
	if err := f.svc.AssignTitle(f.ctx, f.admin(), AssignInput{UserID: u, TitlePublicID: tt.ID}); err == nil {
		t.Fatal("审计失败必须向上报错")
	}
}

func TestRegisterRoutesDoNotConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	perm := func(_ ...string) gin.HandlerFunc { return noop }
	h := NewHandler(nil, nil, func(*gin.Context) (*authz.Actor, bool) { return f_admin(), true })
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("注册路由 panic: %v", r)
			}
		}()
		h.Register(engine.Group("/api/v1"), noop, perm)
	}()
	got := map[string]bool{}
	for _, rt := range engine.Routes() {
		got[rt.Method+" "+rt.Path] = true
	}
	for _, want := range []string{
		"GET /api/v1/titles",
		"GET /api/v1/users/:handle/titles",
		"PUT /api/v1/me/title",
		"POST /api/v1/admin/users/:id/titles/:titleId",
		"DELETE /api/v1/admin/users/:id/titles/:titleId",
		"GET /api/v1/admin/titles",
		"POST /api/v1/admin/titles",
		"PATCH /api/v1/admin/titles/:id",
		"DELETE /api/v1/admin/titles/:id",
	} {
		if !got[want] {
			t.Fatalf("缺少路由 %s（实际 %v）", want, got)
		}
	}
}

func f_admin() *authz.Actor { return &authz.Actor{UserID: 1, IsSuper: true} }

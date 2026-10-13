package forum

import (
	"testing"
	"time"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// mustAppErr 把错误取成带码的错误；断言失败立即终止用例。
func mustAppErr(t *testing.T, err error) *apperr.Error {
	t.Helper()
	if err == nil {
		t.Fatal("期望报错，实际成功")
	}
	ae, ok := err.(*apperr.Error)
	if !ok {
		t.Fatalf("期望业务错误，实际 %T: %v", err, err)
	}
	return ae
}

// ACL 六步（拍板 §1.5 / §4.1.1）。**每条断言错误码**，不只断言「失败」。
func TestCanSpeakSixSteps(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	super := h.seedRole("superadmin", true)
	user := h.seedUser("alice", role, 5, false)

	cases := []struct {
		name    string
		slug    string
		openACL bool // 这个分区不开 ACL（只测禁言与门槛时用它，否则会被第 6 步白名单制挡住）
		setup   func(boardID int64)
		actor   *authz.Actor
		wantErr string
	}{
		{
			name:  "第1步 超管放行（连 ACL 行都不需要）",
			slug:  "s1",
			setup: func(boardID int64) {},
			actor: h.super(h.seedUser("root", super, 1, false), super),
		},
		{
			name:    "第2步 未过期禁言优先于 ACL",
			slug:    "s2a",
			setup:   func(boardID int64) { h.sanction(user, nil, "all", ptrTime(h.clk.Now().Add(time.Hour))) },
			actor:   h.actor(user, role, authz.PermTopicCreate),
			wantErr: "forum.sanctioned",
		},
		{
			name:    "第2步 已过期禁言不生效",
			slug:    "s2b",
			openACL: true,
			setup: func(boardID int64) { h.sanction(user, nil, "all", ptrTime(h.clk.Now().Add(-time.Hour))) },
			actor: h.actor(user, role, authz.PermTopicCreate),
		},
		{
			name:  "第3步 acl_enabled=false → 登录即可发言",
			slug:  "open",
			setup: func(boardID int64) {},
			actor: h.actor(user, role, authz.PermTopicCreate),
		},
		{
			name: "第4步 基线角色那一行 deny → 拒绝",
			slug: "s4",
			setup: func(boardID int64) {
				h.setACL(boardID, role, false, true, "post")
			},
			actor:   h.actor(user, role, authz.PermTopicCreate),
			wantErr: "board.acl_denied",
		},
		{
			name: "第5步 同一行 can → 放行",
			slug: "s5",
			setup: func(boardID int64) {
				h.setACL(boardID, role, true, false, "post")
			},
			actor: h.actor(user, role, authz.PermTopicCreate),
		},
		{
			name: "第6步 该角色没有任何行 → 拒绝（白名单制）",
			slug: "s6",
			setup: func(boardID int64) {
				// 给**别的**角色建一行：本角色仍然没有行。
				other := h.seedRole("creator", false)
				h.setACL(boardID, other, true, false, "post")
			},
			actor:   h.actor(user, role, authz.PermTopicCreate),
			wantErr: "board.acl_denied",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 子用例共用同一个 schema：把上一条留下的禁言清掉，否则顺序会互相影响。
			if _, err := h.pool.Exec(h.ctx, "DELETE FROM sanctions"); err != nil {
				t.Fatal(err)
			}
			// 每个子用例只建一个分区；acl_enabled 按用例要求给。
			boardID := h.seedBoard(tc.slug, 0, !tc.openACL && tc.slug != "open")
			tc.setup(boardID)
			err := h.svc.canSpeak(h.ctx, tc.actor, boardID, "post")
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("用例 %q：期望放行，实际 %v", tc.name, err)
				}
				return
			}
			assertCode(t, err, tc.wantErr)
		})
	}
}

// 禁言的三种时间形态（§11.3 第 15/16 条）：过去放行、将来拒绝且带 until、NULL 永久。
func TestSanctionScopeAndExpiry(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	user := h.seedUser("bob", role, 3, false)
	boardA := h.seedBoard("a", 0, false)
	boardB := h.seedBoard("b", 0, false)

	// 分区 A 的禁言不影响分区 B。
	h.sanction(user, &boardA, "all", ptrTime(h.clk.Now().Add(time.Hour)))
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(user, role), boardA, "post"), "forum.sanctioned")
	if err := h.svc.canSpeak(h.ctx, h.actor(user, role), boardB, "post"); err != nil {
		t.Fatalf("分区 B 不该被分区 A 的禁言影响: %v", err)
	}

	// 全站禁言在任何分区都生效，且 until 进 fields。
	if _, err := h.pool.Exec(h.ctx, "DELETE FROM sanctions"); err != nil {
		t.Fatal(err)
	}
	h.sanction(user, nil, "all", ptrTime(h.clk.Now().Add(time.Hour)))
	err := h.svc.canSpeak(h.ctx, h.actor(user, role), boardB, "post")
	assertCode(t, err, "forum.sanctioned")
	if mustAppErr(t, err).Fields["until"] == "" {
		t.Fatal("带到期时间的禁言必须给出 fields.until")
	}

	// 永久禁言：until IS NULL，msg 里不带到期时间。
	if _, err := h.pool.Exec(h.ctx, "DELETE FROM sanctions"); err != nil {
		t.Fatal(err)
	}
	h.sanction(user, nil, "all", nil)
	err = h.svc.canSpeak(h.ctx, h.actor(user, role), boardB, "post")
	assertCode(t, err, "forum.sanctioned")
	if _, ok := mustAppErr(t, err).Fields["until"]; ok {
		t.Fatal("永久禁言不该带 fields.until")
	}
}

// 发帖门槛（§11.3 第 18 条）：等级不够 403 forum.level_too_low 且带 level。
func TestMinPostLevel(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	user := h.seedUser("carol", role, 2, false)
	boardID := h.seedBoard("gated", 5, false)

	err := h.svc.canSpeak(h.ctx, h.actor(user, role), boardID, "post")
	assertCode(t, err, "forum.level_too_low")
	if mustAppErr(t, err).Fields["level"] != "5" {
		t.Fatalf("fields.level 应为 5，实际 %v", mustAppErr(t, err).Fields)
	}

	if _, err := h.pool.Exec(h.ctx, "UPDATE users SET level = 5 WHERE id = $1", user); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.canSpeak(h.ctx, h.actor(user, role), boardID, "post"); err != nil {
		t.Fatalf("等级够了却仍被拒: %v", err)
	}
}

// 归档分区不算「能发言的分区」：ACL 那条查询带 status='active'，0 行 → board.not_found。
func TestArchivedBoardDeniesSpeaking(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	user := h.seedUser("dave", role, 9, false)
	boardID := h.seedBoard("archived", 0, false)
	if _, err := h.pool.Exec(h.ctx, "UPDATE boards SET status = 'archived' WHERE id = $1", boardID); err != nil {
		t.Fatal(err)
	}
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(user, role), boardID, "post"), "board.not_found")
}

func ptrTime(t time.Time) *time.Time { return &t }

package forum

import (
	"context"
	"strconv"
	"time"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// canSpeak 是发帖与回复共用的那一个函数（§4.1.1 = 拍板 §1.5 的六步落地）。
// action: "post" | "reply"。
//
// 六步的顺序不能挪：
//  1. 超管放行（这条 SQL 都不查）；
//  2. 未过期禁言优先于 ACL——被禁言者拿到的应该是「你被禁止发言（至 …）」，不是含糊的「没权限」；
//  3. acl_enabled=false → 登录即可发言（还要过等级门槛）；
//  4. 基线角色那一行的 deny_* → 拒绝（禁止优先）；
//  5. 同一行 can_* → 放行（仍要过等级门槛）；
//  6. 该分区没有任何该角色的行 → 拒绝（白名单制）。
//
// 「禁止优先」在表结构上就成立了：ck_board_acls_no_contradiction 不允许同一行既 deny 又 can，
// 所以第 4 步与第 5 步永远只有一个会命中。
//
// 只覆盖五条「新增内容」路径：发主题、发回复、发 issue、发 issue 评论、传配图。
// **编辑、删除、锁定、置顶、收藏、投票都不判发言权**——被禁言的人当然要能删掉自己违规的内容。
func (s *Service) canSpeak(ctx context.Context, actor *authz.Actor, boardID int64, action string) error {
	if actor.IsSuper {
		return nil
	}
	row, err := s.repo.ACLRowFor(ctx, boardID, actor.RoleID, actor.UserID, action, s.clk.Now())
	if err != nil {
		if err == pgsql.ErrNoRows {
			// 分区不存在或已归档：不能在一个不存在的分区里发言（§6.1 的 WHERE 带 status='active'）。
			return ErrBoardNotFound
		}
		return err
	}
	if row.HasSanction {
		if row.SanctionPerm {
			return ErrSanctioned // until IS NULL = 永久，msg 里不带到期时间（§6.3）
		}
		until := row.SanctionUntil.UTC()
		return ErrSanctioned.
			WithMsg("你被禁止在此发言（至 " + until.Format("2006-01-02 15:04") + " UTC）").
			WithFields(map[string]string{"until": until.Format(time.RFC3339)})
	}
	// 两档门槛（拍板 08 · E1）：发主题看 min_post_level，回复 / Issue / Issue 评论看 min_reply_level。
	minLevel := row.MinReplyLevel
	if action == "post" {
		minLevel = row.MinPostLevel
	}
	if !row.ACLEnabled {
		return s.checkMinLevel(ctx, actor, minLevel, action)
	}
	if row.Deny(action) {
		return ErrACLDenied
	}
	if row.Can(action) {
		return s.checkMinLevel(ctx, actor, minLevel, action)
	}
	return ErrACLDenied
}

// checkMinLevel 是发言门槛（§6.4）：放在最后，因为它是唯一要读 users 的一步。
// level 公式（floor(sqrt(exp/100))+1）的唯一实现在 D4，本域只读一个数。
//
// action 只影响**文案**（「发帖」/「回帖」）：两档门槛的数字由调用方选好，
// 这里再判一次 action 就等于把「哪一档」写两遍。
func (s *Service) checkMinLevel(ctx context.Context, actor *authz.Actor, minLevel int, action string) error {
	if minLevel <= 0 {
		return nil
	}
	level, err := s.repo.UserLevel(ctx, actor.UserID)
	if err != nil {
		return err
	}
	if level >= minLevel {
		return nil
	}
	what := "回帖"
	if action == "post" {
		what = "发帖"
	}
	want := strconv.Itoa(minLevel)
	return ErrLevelTooLow.
		WithMsg("需要 " + want + " 级才能在此" + what).
		WithFields(map[string]string{"level": want})
}

// checkBlocks 是拉黑判定（§4.1.1 末段）：只在「回复别人的内容」时判，
// 双向任一命中 → 403，**不告诉他是谁拉黑了谁**。
// 拉黑是「别再跟我说话」，不是「别看我的帖」——所以读路径一概不判。
func (s *Service) checkBlocks(ctx context.Context, actor *authz.Actor, targetUserID int64) error {
	if actor.UserID == targetUserID {
		return nil // 自己回自己的帖永远可以
	}
	iBlocked, theyBlocked, err := s.repo.BlockedBetween(ctx, actor.UserID, targetUserID)
	if err != nil {
		return err
	}
	if iBlocked || theyBlocked {
		return ErrBlocked
	}
	return nil
}

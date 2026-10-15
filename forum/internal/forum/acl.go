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
		// **deny 在白名单关闭时仍然终局**（D62，2026-10-15 用户实测「组禁发帖没生效——任何组仍能发」）：
		// 第 3 步「白名单关 → 登录即可发言」原本把整个矩阵连同 deny 一起跳过，而分区默认
		// acl_enabled=false——管理员给组/角色戴上的禁令实际从不生效。禁令是 prohibitive：
		// 无论白名单开不开都拒绝；can 侧与等级门槛不在此列（那是「加」出来的授权方向）。
		if row.Deny(action) || row.DenyGroup(action) {
			return ErrACLDenied
		}
		return s.checkMinLevel(ctx, actor, minLevel, action)
	}
	// 显式 deny 终局（D38 拍板语义②）：基线角色那一行与组的行**任一层** deny 都直接拒绝，
	// 另一层 can 多少都救不回来 —— 与同表 CHECK 的「一行不矛盾」是同一个精神，跨两层同样成立。
	if row.Deny(action) || row.DenyGroup(action) {
		return ErrACLDenied
	}
	// 组授是**加法授权**（语义①）：白名单之下多出一条可发 / 可回的路径。
	// 基线角色那一行 can（第 5 步照旧）或任一组行 can，都只走到等级门槛，不改变先后顺序。
	if row.Can(action) || row.CanGroup(action) {
		return s.checkMinLevel(ctx, actor, minLevel, action)
	}
	// 组白名单在场上（板上配了组规则）时把「为什么不行」说人话（同一码 board.acl_denied，不发新码）：
	// 管理员把组配进名单了，进来的人却不在任何组里 —— 拒绝理由组比角色更贴切。
	if row.BoardGroupRows {
		what := "回帖"
		if action == "post" {
			what = "发帖"
		}
		return ErrACLDenied.WithMsg("本分区仅特定用户组的成员可以在此" + what + "；你不具有该分区的发言资格")
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

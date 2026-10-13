package forum

import (
	"context"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// Vote 是幂等的投票（§5.1）。target 决定票数落在哪张表的哪个列上（§5.2）。
//
// 主题只有赞：target=topic 时 value 必须是 +1，-1 → 400。
// 点赞通知只在「新建或由 -1 改成 1」时投（§8.3）——重复点赞不该再通知一次。
func (s *Service) Vote(ctx context.Context, actor *authz.Actor, target VoteTarget, publicID string, value int) (*VoteResultDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if value != 1 && value != -1 {
		return nil, ErrVoteValue
	}
	if target == VoteTopic && value != 1 {
		return nil, ErrVoteValue
	}
	table, ok := voteTable(target)
	if !ok {
		return nil, invalid("target", "不支持的投票目标")
	}
	targetID, err := s.resolveVoteTarget(ctx, actor, table, target, publicID)
	if err != nil {
		return nil, err
	}
	now := s.clk.Now().UTC()
	var like, dislike int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		changed, err := pgsql.Vote(ctx, tx, string(target), targetID, actor.UserID, value, now)
		if err != nil {
			return err
		}
		like, dislike, err = s.repo.VoteCounts(ctx, tx, string(target), targetID)
		if err != nil {
			return err
		}
		if changed && value == 1 {
			// notify:like 的消费者在 D4（社交域），任务类型常量届时加到 platform/queue。
			return s.enqueue(ctx, tx, queue.Task{
				Type:    "notify:like",
				Payload: map[string]int64{"id": targetID, "user_id": actor.UserID},
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &VoteResultDTO{LikeCount: like, DislikeCount: dislike, MyVote: value}, nil
}

// Unvote 是幂等的取消（§5.3）：没有票时 200 + 当前计数，不是 404。
func (s *Service) Unvote(ctx context.Context, actor *authz.Actor, target VoteTarget, publicID string) (*VoteResultDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	table, ok := voteTable(target)
	if !ok {
		return nil, invalid("target", "不支持的投票目标")
	}
	targetID, err := s.resolveVoteTarget(ctx, actor, table, target, publicID)
	if err != nil {
		return nil, err
	}
	var like, dislike int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		var err error
		// 取消是幂等的：没有票时删 0 行也是成功，计数原样返回（§5.3）。
		like, dislike, err = s.repo.Unvote(ctx, tx, string(target), targetID, actor.UserID)
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	// 取消后 my_vote 恒为 0；主题没有踩，所以两个数字里只有 like 有意义。
	return &VoteResultDTO{LikeCount: like, DislikeCount: dislike, MyVote: 0}, nil
}

// resolveVoteTarget 把 public_id 解成内部 id，并回答「这一行对外存在吗」。
// 主题不可见 / 楼层不可见 / 评论不可见一律 404（不区分原因，区分就是探测口）。
func (s *Service) resolveVoteTarget(ctx context.Context, actor *authz.Actor, table string, target VoteTarget, publicID string) (int64, error) {
	switch target {
	case VoteTopic:
		ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
		if err != nil {
			if err == pgsql.ErrNoRows {
				return 0, ErrTopicNotFound
			}
			return 0, err
		}
		return ref.ID, nil
	case VotePost:
		ref, err := s.postRef(ctx, actor, publicID)
		if err != nil {
			return 0, err
		}
		return ref.ID, nil
	case VoteIssueComment:
		ref, err := s.repo.IssueCommentRef(ctx, publicID, actor.UserID)
		if err != nil {
			if err == pgsql.ErrNoRows {
				return 0, ErrIssueNotFound
			}
			return 0, err
		}
		return ref.ID, nil
	default:
		return 0, invalid("target", "不支持的投票目标")
	}
}

func voteTable(t VoteTarget) (string, bool) {
	switch t {
	case VotePost:
		return "posts", true
	case VoteTopic:
		return "topics", true
	case VoteIssueComment:
		return "issue_comments", true
	default:
		return "", false
	}
}

// Bookmark 是收藏 / 取消收藏（§5.4），两端都幂等。
func (s *Service) Bookmark(ctx context.Context, actor *authz.Actor, topicPublicID string, on bool) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	ref, err := s.repo.TopicRef(ctx, topicPublicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return err
	}
	if on {
		return s.repo.InsertBookmark(ctx, actor.UserID, ref.ID, s.clk.Now().UTC())
	}
	return s.repo.DeleteBookmark(ctx, actor.UserID, ref.ID)
}

// BlockUser 是拉黑 / 取消拉黑（§4.1.1）。方向性明确：A 拉黑 B 不影响 B 看 A。
// 不能拉黑自己（ck_blocks_not_self）——那不是校验失败，是请求本身没意义。
func (s *Service) BlockUser(ctx context.Context, actor *authz.Actor, handle string, on bool) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	user, err := s.repo.UserBriefByHandle(ctx, handle)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return apperr.New("user.not_found", 404, "用户不存在")
		}
		return err
	}
	if user.ID == actor.UserID {
		return invalid("handle", "不能拉黑自己")
	}
	if on {
		return s.repo.InsertBlock(ctx, actor.UserID, user.ID, s.clk.Now().UTC())
	}
	return s.repo.DeleteBlock(ctx, actor.UserID, user.ID)
}

// BlockedBetween 给 D4 的私信域用（接口在使用方定义，本域只是碰巧实现了它）。
func (s *Service) BlockedBetween(ctx context.Context, a, b int64) (bool, bool, error) {
	return s.repo.BlockedBetween(ctx, a, b)
}

// ResolveTargetOwner 给 D6 的举报域用：target_type + target_id → 作者 id。
func (s *Service) ResolveTargetOwner(ctx context.Context, targetType string, targetID int64) (int64, error) {
	owner, err := s.repo.TargetOwner(ctx, targetType, targetID)
	if err == pgsql.ErrNoRows {
		return 0, apperr.ErrNotFound
	}
	return owner, err
}

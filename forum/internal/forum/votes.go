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
	vt, err := s.resolveVoteTarget(ctx, actor, target, publicID)
	if err != nil {
		return nil, err
	}
	now := s.clk.Now().UTC()
	var like, dislike int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		changed, err := pgsql.Vote(ctx, tx, string(target), vt.id, actor.UserID, value, now)
		if err != nil {
			return err
		}
		like, dislike, err = s.repo.VoteCounts(ctx, tx, string(target), vt.id)
		if err != nil {
			return err
		}
		if changed && value == 1 {
			// payload 的形状是**消费方 notify 定的**（§8.1 定稿）：
			// {ref_type, ref_id, topic_id, actor_id}，任务类型用 platform/queue 的常量。
			// 曾经这里发的是字面量 "notify:like" + {"id","user_id"}：notify 解出的 ref_type 为空
			// → 「不认识的 ref_type」→ 重试 5 次进 dead。
			return s.enqueue(ctx, tx, queue.Task{
				Type: queue.TypeNotifyLike,
				Payload: map[string]any{
					"actor_id": actor.UserID, "ref_type": vt.kind, "ref_id": vt.id, "topic_id": vt.topicID,
				},
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
	vt, err := s.resolveVoteTarget(ctx, actor, target, publicID)
	if err != nil {
		return nil, err
	}
	var like, dislike int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// 取消是幂等的：没有票时删 0 行也是成功（§5.3）——那种情况 UPDATE 不返回行，
		// 回读当前计数；目标不存在时回读也会 0 行，那时才是 404。
		like, dislike, err = s.repo.Unvote(ctx, tx, string(target), vt.id, actor.UserID)
		if err != pgsql.ErrNoRows {
			return err
		}
		var readErr error
		like, dislike, readErr = s.repo.VoteCounts(ctx, tx, string(target), vt.id)
		if readErr == pgsql.ErrNoRows {
			return ErrTopicNotFound
		}
		return readErr
	})
	if err != nil {
		return nil, err
	}
	// 取消后 my_vote 恒为 0；主题没有踩，所以两个数字里只有 like 有意义。
	return &VoteResultDTO{LikeCount: like, DislikeCount: dislike, MyVote: 0}, nil
}

// voteTargetRef 是投票目标解析出来的三件事。**ref_type 与 ref_id 在这里算一次**，
// 不再由调用点各算一遍（两份就会漂移，见 _P2-修正清单 §8.1）。
type voteTargetRef struct {
	id   int64  // 内部 id：写票数、算 dedup_key 都用它
	kind string // notify 的 ref_type：post | topic | comment
	// topicID 是通知要的 topic_id：楼层与 issue 评论各有归属主题，主题就是它自己。
	topicID int64
}

// resolveVoteTarget 把 public_id 解成内部 id，并回答「这一行对外存在吗」。
// 主题不可见 / 楼层不可见 / 评论不可见一律 404（不区分原因，区分就是探测口）。
func (s *Service) resolveVoteTarget(ctx context.Context, actor *authz.Actor, target VoteTarget, publicID string) (voteTargetRef, error) {
	switch target {
	case VoteTopic:
		ref, err := s.repo.TopicRef(ctx, publicID, actor.UserID, canReview(actor))
		if err != nil {
			if err == pgsql.ErrNoRows {
				return voteTargetRef{}, ErrTopicNotFound
			}
			return voteTargetRef{}, err
		}
		return voteTargetRef{id: ref.ID, kind: notifyRefTopic, topicID: ref.ID}, nil
	case VotePost:
		ref, err := s.postRef(ctx, actor, publicID)
		if err != nil {
			return voteTargetRef{}, err
		}
		return voteTargetRef{id: ref.ID, kind: notifyRefPost, topicID: ref.TopicID}, nil
	case VoteIssueComment:
		ref, err := s.repo.IssueCommentRef(ctx, publicID, actor.UserID)
		if err != nil {
			if err == pgsql.ErrNoRows {
				return voteTargetRef{}, ErrIssueNotFound
			}
			return voteTargetRef{}, err
		}
		// likes.target_type='issue_comment' → notify 的 ref_type="comment"
		// （NotifyLike 只认 post/topic/comment 三个，§8.1 的映射规则）。
		return voteTargetRef{id: ref.ID, kind: notifyRefComment, topicID: ref.TopicID}, nil
	default:
		return voteTargetRef{}, invalid("target", "不支持的投票目标")
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

package forum

import (
	"context"
	"strings"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// ---- 读：楼层 ----

// ListPosts 是某个主题的顶层回复（§3.4 Q3a）。主题不可见时整条拒绝，
// **不在楼层上再判一次主题状态**（§3.4 末段）。
func (s *Service) ListPosts(ctx context.Context, actor *authz.Actor, in ListPostsInput) (*PostPage, error) {
	ref, err := s.repo.TopicRef(ctx, in.TopicPublicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	limit := limitOf(in.Limit)
	cursorID, err := intCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.TopLevelReplies(ctx, ref.ID, viewerID(actor), cursorID, limit)
	if err != nil {
		return nil, err
	}
	items := make([]PostDTO, 0, len(rows))
	for _, r := range rows {
		items = append(items, postDTO(r))
	}
	return &PostPage{Items: items, NextCursor: nextIntCursor(rows, limit, func(r pgsql.PostRow) int64 { return r.ID })}, nil
}

// ListReplies 是楼中楼（§3.4 Q3b）：一级、200 条硬上限。
func (s *Service) ListReplies(ctx context.Context, actor *authz.Actor, postPublicID string) ([]PostDTO, error) {
	ref, err := s.postRef(ctx, actor, postPublicID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.Replies(ctx, ref.ID, viewerID(actor))
	if err != nil {
		return nil, err
	}
	out := make([]PostDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, postDTO(r))
	}
	return out, nil
}

func postDTO(r pgsql.PostRow) PostDTO {
	// 直接透传指针：nil 就是顶层。**不要再 deref** —— 那会把 NULL 变成空串，
	// 而契约（前端 forum.ts / mappers.ts）判的是 null。
	ids := make([]string, 0, len(r.PreviewIDs))
	ids = append(ids, r.PreviewIDs...)
	return PostDTO{
		ID: r.PublicID, ParentID: r.ParentPublicID, Floor: r.Floor, ContentHTML: r.ContentHTML,
		Author: userBriefDTO(r.Author), LikeCount: r.LikeCount, DislikeCount: r.DislikeCount,
		MyVote: r.MyVote, ReplyTotal: r.ReplyTotal, PreviewIDs: ids,
		CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
}

// ---- 写：回复 ----

// CreatePost 是发回复 / 楼中楼（§4.4）。事务里的顺序写死：
//   - 锁主题行（让同一主题的并发分配 floor 串行）——全域唯一需要 FOR UPDATE 的地方；
//   - 分配 floor 并插入；
//   - 推 last_reply_at 与重算 reply_count（同一事务，读后写一致）。
//
// parent_id 只允许指向该主题的**顶层**回复：跨主题 400、二级 400、已删 404。
func (s *Service) CreatePost(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreatePostInput) (*PostDTO, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermTopicCreate); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.ContentMD) == "" {
		return nil, invalid("content_md", "回复不能为空")
	}
	if len(in.ClientToken) > 64 {
		return nil, invalid("client_token", "长度不能超过 64")
	}
	ref, err := s.repo.TopicRef(ctx, topicPublicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	// 判定顺序（§4.1）：先回答「你看不看得见这一行」，再回答「你能不能对它做这件事」。
	if ref.ReviewState == "pending" {
		return nil, ErrReviewPending
	}
	if ref.LockedAt != nil {
		return nil, ErrTopicLocked
	}
	// 回复别人的主题：拉黑判定在事务之外（判定失败不该开事务）。
	if err := s.checkBlocks(ctx, actor, ref.AuthorID); err != nil {
		return nil, err
	}
	if err := s.canSpeak(ctx, actor, ref.BoardID, "reply"); err != nil {
		return nil, err
	}
	html, _, err := s.render(in.ContentMD)
	if err != nil {
		return nil, err
	}

	now := s.clk.Now().UTC()
	var postID int64
	err = s.insertPost(ctx, actor, ref, in, html, now, &postID)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.PostByID(ctx, postID, actor.UserID)
	if err != nil {
		return nil, err
	}
	d := postDTO(*row)
	return &d, nil
}

// insertPost 是发回复的写事务（§4.4）。
//
// 幂等键撞车走**回滚后重来一次**这条路（§4.3）：一条语句报错会把整个事务置为 aborted，
// 同一事务内再查只会拿到 25P02，所以「插入失败后回查」必须在事务之外做。
func (s *Service) insertPost(ctx context.Context, actor *authz.Actor, ref *pgsql.TopicRef, in CreatePostInput,
	html string, now time.Time, postID *int64) error {
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		// ① 顶行锁。锁的是主题行不是 posts：posts 上没有「帖内计数」要保护。
		locked, err := pgsql.TopicRefForUpdate(ctx, tx, ref.ID)
		if err != nil {
			return err
		}
		if locked.LockedAt != nil {
			return ErrTopicLocked
		}
		// ② parent_id 的校验只有这一处（DB 做不到跨行 CHECK）。
		var parentID *int64
		if in.ParentID != "" {
			parent, err := s.repo.PostRef(ctx, in.ParentID, actor.UserID, canReview(actor))
			if err != nil {
				if err == pgsql.ErrNoRows {
					return ErrPostNotFound
				}
				return err
			}
			if parent.TopicID != ref.ID {
				return ErrParentTopic
			}
			if parent.ParentID != nil {
				return ErrParentNested
			}
			if parent.Visibility != "normal" {
				return ErrPostNotFound
			}
			if err := s.checkBlocks(ctx, actor, parent.AuthorID); err != nil {
				return err
			}
			parentID = &parent.ID
		}
		// ③ 分配 floor 并插入。
		id, _, err := pgsql.InsertPost(ctx, tx, newPublicID(), ref.ID, actor.UserID, parentID,
			in.ContentMD, html, in.ClientToken, now)
		if err != nil {
			return err
		}
		*postID = id
		// ④ reply_count 与 last_reply_at：重算而不是增量（§3.7 Q8a 的取舍）。
		if err := pgsql.RecountTopic(ctx, tx, ref.ID); err != nil {
			return err
		}
		// ⑤ 通知与索引。payload 只能放 id 一类最小形状（拍板 §5.7：任务执行时再查一次库），
		// **但形状必须与消费方（notify）逐字一致**——它解的是
		// {actor_id, ref_type, ref_id, topic_id}（notify.CreateNotifyInput，§8.1 的定稿）。
		// 曾经这里只发 {"id": id}：ref_id 解成 0 → 查不到楼层 → 静默 return nil，
		// 任务照样 done、通知一行都没有（「任务成功」与「通知产生」是两件事）。
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeNotifyReply,
			Payload: map[string]any{
				"actor_id": actor.UserID, "ref_type": notifyRefPost, "ref_id": id, "topic_id": ref.ID,
			},
		})
	})
	if err == nil || in.ClientToken == "" || !isUniqueViolation(err) {
		return err
	}
	existing, _, lookupErr := s.repo.PostIDByClientToken(ctx, actor.UserID, in.ClientToken)
	if lookupErr != nil {
		return err
	}
	*postID = existing
	return nil
}

// UpdatePost 是 PATCH /posts/{id}：作者或管理端。**不动 last_reply_at**（编辑不是回复）。
// 编辑 1 楼正文时同步主题的 excerpt 与 updated_at，并重投搜索索引（§4.5）。
func (s *Service) UpdatePost(ctx context.Context, actor *authz.Actor, publicID, contentMD string) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicEditOwn); err != nil {
		return err
	}
	if strings.TrimSpace(contentMD) == "" {
		return invalid("content_md", "正文不能为空")
	}
	ref, err := s.postRef(ctx, actor, publicID)
	if err != nil {
		return err
	}
	if !canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID) {
		return apperr.ErrForbidden
	}
	html, plain, err := s.render(contentMD)
	if err != nil {
		return err
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if err := pgsql.UpdatePostContent(ctx, tx, ref.ID, contentMD, html, now); err != nil {
			return err
		}
		if ref.Floor == 1 {
			if err := pgsql.SetTopicExcerpt(ctx, tx, ref.TopicID, clipExcerpt(plain), now); err != nil {
				return err
			}
		}
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": ref.TopicID}, UniqueKey: "topic:" + itoa64(ref.TopicID),
		})
	})
}

// DeletePost 是删楼层（§4.6）：1 楼只软删自己（标题还在），回复还要重算两个派生列。
func (s *Service) DeletePost(ctx context.Context, actor *authz.Actor, publicID string) error {
	if _, err := requireActor(actor); err != nil {
		return err
	}
	if err := requirePerm(actor, authz.PermTopicDeleteOwn); err != nil {
		return err
	}
	ref, err := s.postRef(ctx, actor, publicID)
	if err != nil {
		return err
	}
	if !canEditTopic(actor, authz.PermTopicDeleteOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID) {
		return apperr.ErrForbidden
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if err := pgsql.DeletePostRow(ctx, tx, ref.ID, now); err != nil {
			return err
		}
		if ref.Floor > 1 {
			// 楼中楼也跑这句：reply_count 与 last_reply_at 都是「帖子整体」的派生量，不区分层级。
			if err := pgsql.RecountTopic(ctx, tx, ref.TopicID); err != nil {
				return err
			}
		}
		return s.enqueue(ctx, tx, queue.Task{
			Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": ref.TopicID}, UniqueKey: "topic:" + itoa64(ref.TopicID),
		})
	})
}

// ---- 内部 ----

// postRef 取一条楼层并回答「它存不存在（对外）」。楼层被隐藏但属于我时仍然拿得到。
func (s *Service) postRef(ctx context.Context, actor *authz.Actor, publicID string) (*pgsql.PostRef, error) {
	ref, err := s.repo.PostRef(ctx, publicID, viewerID(actor), canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrPostNotFound
		}
		return nil, err
	}
	return ref, nil
}

// firstPostID 取主题的 1 楼 id。它必然存在（不会物理删除），所以查不到就是数据坏了。
func (s *Service) firstPostID(ctx context.Context, topicID int64) (int64, error) {
	return s.repo.PostIDByFloor(ctx, topicID, 1)
}

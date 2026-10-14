package forum

import (
	"context"
	"errors"
	"strings"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/board"
	"forum/internal/forum/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/platform/image"
)

// 管理端分区的写路径（交接单 C2 / 界面需求 §5.10）。权限点一律 board.manage。

// AuditBoard* 是分区管理的审计动作名。board.acl.update / board.moderate.grant 与设计稿的
// AUDIT_ACTION_LABEL 逐字对齐（后台审计屏直接按 key 显示中文标签）。
const (
	AuditBoardCreate         = "board.create"
	AuditBoardUpdate         = "board.update"
	AuditBoardReorder        = "board.reorder"
	AuditBoardACLUpdate      = "board.acl.update"
	AuditBoardModerateGrant  = "board.moderate.grant"
	AuditBoardModerateRevoke = "board.moderate.revoke"
)

// withTx 是 platform/db.WithTx 的别名：本域别处直接调 db.WithTx，
// 而管理端写路径有 5 处事务，收一个方法少写 5 遍参数。
func (s *Service) withTx(ctx context.Context, fn func(tx *ent.Tx) error) error {
	return db.WithTx(ctx, s.db, fn)
}

// incBoardCover / decBoardCover 是分区封面维护引用计数的两个薄壳（d5 §4.3）。
//
// deps.Media 为 nil 时不动作 —— 测试台与「只关心分区、不关心图片」的调用方不需要它；
// 但**生产装配必须给**（app/modules.go），否则换掉的旧封面永远留在盘上：
// GC 只收 refcount 归零的行，而论坛域挂了 hash 却不计数，那张图的行永远停在 1。
func (s *Service) incBoardCover(ctx context.Context, tx *ent.Tx, hash string) error {
	if s.deps.Media == nil {
		return nil
	}
	return s.deps.Media.IncRefTx(ctx, tx, image.Hash(hash))
}

func (s *Service) decBoardCover(ctx context.Context, tx *ent.Tx, hash string) error {
	if s.deps.Media == nil {
		return nil
	}
	return s.deps.Media.DecRefTx(ctx, tx, image.Hash(hash))
}

// CreateBoard 建一个分区。
func (s *Service) CreateBoard(ctx context.Context, actor *authz.Actor, in CreateBoardInput) (*AdminBoardDTO, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	slug := strings.TrimSpace(in.Slug)
	name := strings.TrimSpace(in.Name)
	desc := strings.TrimSpace(in.Description)
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = boardStatusActive
	}
	if !boardSlugRe.MatchString(slug) {
		return nil, invalid("slug", "2-32 位小写字母、数字或连字符，且以字母数字开头")
	}
	if name == "" || len([]rune(name)) > maxBoardNameLen {
		return nil, invalid("name", "名称必填，最多 32 个字")
	}
	if len([]rune(desc)) > maxBoardDescLen {
		return nil, invalid("description", "简介最多 200 个字")
	}
	if !boardStatuses[status] {
		return nil, invalid("status", "只能是 active / archived")
	}
	if in.MinPostLevel < 0 {
		return nil, invalid("min_post_level", "不能是负数")
	}
	now := s.clk.Now()
	var createdID int64
	var createdPublic string
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		c := tx.Board.Create().
			SetSlug(slug).SetName(name).SetDescription(desc).SetStatus(status).
			SetACLEnabled(in.ACLEnabled).SetMinPostLevel(int32(in.MinPostLevel)).
			SetCreatedAt(now).SetUpdatedAt(now)
		if in.CoverHash != nil && *in.CoverHash != "" {
			c.SetCoverHash(*in.CoverHash)
		}
		b, err := c.Save(ctx)
		if err != nil {
			if isUniqueViolation(err) {
				return invalid("slug", "这个 slug 已经被占用")
			}
			return err
		}
		createdID = b.ID
		// 封面挂上去了 → 在同一事务里 +1（d5 §4.3：引用行在谁的表里，谁负责调 IncRefTx）。
		if in.CoverHash != nil && *in.CoverHash != "" {
			if err := s.incBoardCover(ctx, tx, *in.CoverHash); err != nil {
				return err
			}
		}
		// public_id 是迁移 0050 加的一列，ent 的 Board 实体里没有它（不重新生成 ent 代码：
		// 管理端的读路径本来就全走本域的 pgsql）。这里读回它只为了写审计的目标 ID。
		if err := pgsql.QueryRow(ctx, tx, "SELECT public_id::text FROM boards WHERE id = $1", b.ID).
			Scan(&createdPublic); err != nil {
			return err
		}
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardCreate, createdPublic, map[string]any{
			"after": map[string]any{
				"slug": slug, "name": name, "status": status,
				"acl_enabled": in.ACLEnabled, "min_post_level": in.MinPostLevel,
			},
		})
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.AdminBoardByID(ctx, createdID, s.todayStart())
	if err != nil {
		return nil, err
	}
	d := adminBoardDTO(*row)
	return &d, nil
}

// UpdateBoard 只改请求里出现的字段（指针 = 没给）。**没有 Slug**：改 slug 等于废掉所有外链。
func (s *Service) UpdateBoard(ctx context.Context, actor *authz.Actor, publicID string, in UpdateBoardInput) (*AdminBoardDTO, error) {
	if err := requireBoardManage(actor); err != nil {
		return nil, err
	}
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" || len([]rune(n)) > maxBoardNameLen {
			return nil, invalid("name", "名称必填，最多 32 个字")
		}
		in.Name = &n
	}
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		if len([]rune(d)) > maxBoardDescLen {
			return nil, invalid("description", "简介最多 200 个字")
		}
		in.Description = &d
	}
	if in.Status != nil && !boardStatuses[*in.Status] {
		return nil, invalid("status", "只能是 active / archived")
	}
	if in.MinPostLevel != nil && *in.MinPostLevel < 0 {
		return nil, invalid("min_post_level", "不能是负数")
	}
	// 空串 = 清空封面，**不折成 nil**：指针 nil 才是「没给这个字段」（见下面 if 的顺序）。
	// 上一版在这里把它折成 nil，于是「只发 {\"cover_hash\":\"\"}」既跳过 SetCoverHash、
	// 又不计入「有没有要改的字段」→ 400「没有要改的字段」，清空封面这条路根本走不通。
	if in.Name == nil && in.Description == nil && in.Status == nil &&
		in.ACLEnabled == nil && in.MinPostLevel == nil && in.CoverHash == nil {
		return nil, invalid("_", "没有要改的字段")
	}
	now := s.clk.Now()
	var boardID int64
	err := s.withTx(ctx, func(tx *ent.Tx) error {
		id, err := s.boardIDByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		before, err := tx.Board.Query().Where(board.IDEQ(id)).Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return ErrBoardNotFound
			}
			return err
		}
		boardID = before.ID
		upd := tx.Board.UpdateOneID(before.ID).SetUpdatedAt(now)
		changed := map[string]any{}
		if in.Name != nil {
			upd.SetName(*in.Name)
			changed["name"] = *in.Name
		}
		if in.Description != nil {
			upd.SetDescription(*in.Description)
			changed["description"] = *in.Description
		}
		if in.Status != nil {
			upd.SetStatus(*in.Status)
			changed["status"] = *in.Status
		}
		if in.ACLEnabled != nil {
			upd.SetACLEnabled(*in.ACLEnabled)
			changed["acl_enabled"] = *in.ACLEnabled
		}
		if in.MinPostLevel != nil {
			upd.SetMinPostLevel(int32(*in.MinPostLevel))
			changed["min_post_level"] = *in.MinPostLevel
		}
		if in.CoverHash != nil {
			old := ""
			if before.CoverHash != nil {
				old = *before.CoverHash
			}
			if *in.CoverHash == "" {
				upd.ClearCoverHash() // 空串 = 置 NULL（d3-forum：cover_hash 为空就是没有封面）
			} else {
				upd.SetCoverHash(*in.CoverHash)
			}
			// 引用计数跟着封面走（d5 §4.3）：换图 = 旧图 −1、新图 +1；清空 = 旧图 −1。
			// **同一张图重复保存时不加减**（否则每保存一次就多欠一次，refcount 会漂到收不回去）。
			if old != *in.CoverHash {
				if old != "" {
					if err := s.decBoardCover(ctx, tx, old); err != nil {
						return err
					}
				}
				if *in.CoverHash != "" {
					if err := s.incBoardCover(ctx, tx, *in.CoverHash); err != nil {
						return err
					}
				}
			}
			changed["cover_hash"] = *in.CoverHash
		}
		if err := upd.Exec(ctx); err != nil {
			return err
		}
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardUpdate, publicID, map[string]any{
			"before": map[string]any{
				"name": before.Name, "status": before.Status,
				"acl_enabled": before.ACLEnabled, "min_post_level": before.MinPostLevel,
			},
			"after": changed,
		})
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.AdminBoardByID(ctx, boardID, s.todayStart())
	if err != nil {
		return nil, err
	}
	d := adminBoardDTO(*row)
	return &d, nil
}

// ReorderBoards 按 ids 的顺序重写 sort。
//
// **必须给全**：ids 少一个就会有分区留在原 sort 上、与别人撞在一起，
// 而「谁在前」从此变成一个说不清的问题。多给、重复、非 uuid 同样拒绝。
func (s *Service) ReorderBoards(ctx context.Context, actor *authz.Actor, ids []string) error {
	if err := requireBoardManage(actor); err != nil {
		return err
	}
	if len(ids) == 0 {
		return invalid("ids", "至少要给一个分区")
	}
	seen := make(map[string]bool, len(ids))
	raw := make([]string, 0, len(ids))
	for _, v := range ids {
		if seen[v] {
			return invalid("ids", "有重复的分区 id："+v)
		}
		seen[v] = true
		if _, err := idgen.ParsePublicID(v); err != nil {
			return invalid("ids", "不是合法的分区 id："+v)
		}
		raw = append(raw, v)
	}
	return s.withTx(ctx, func(tx *ent.Tx) error {
		// 原生 SQL 取 (id, public_id)：ent 的 Board 没有 public_id 这一列（0050 才加）。
		byPublic, err := pgsql.BoardIDsByPublicID(ctx, tx)
		if err != nil {
			return err
		}
		if len(byPublic) != len(raw) {
			return invalid("ids", "分区数量对不上：应当给全部 "+itoa64(int64(len(byPublic)))+" 个分区的 id")
		}
		ordered := make([]int64, 0, len(raw))
		for _, v := range raw {
			id, ok := byPublic[v]
			if !ok {
				return invalid("ids", "这个分区不存在："+v)
			}
			ordered = append(ordered, id)
		}
		if _, err := pgsql.ReorderBoards(ctx, tx, ordered); err != nil {
			return err
		}
		return s.writeBoardAudit(ctx, tx, actor, AuditBoardReorder, "boards", map[string]any{
			"after": map[string]any{"order": raw},
		})
	})
}

// writeBoardAudit 写一条分区管理的审计。分区管理的每一次写都留痕 ——
// 「谁把这个分区设成了禁止回复」是这类后台最常被追问的问题。
func (s *Service) writeBoardAudit(ctx context.Context, tx *ent.Tx, actor *authz.Actor, action, targetID string, detail map[string]any) error {
	if actor == nil {
		return apperr.ErrUnauthorized
	}
	return pgsql.InsertBoardAudit(ctx, tx, actor.UserID, action, targetID, detail, s.clk.Now())
}

// boardIDByPublicID 把对外 ID 换成自增 id。非 uuid 与不存在都给同一个 404
// （与 ErrBoardNotFound 的既有取舍一致：区分「不是那个形状」等于承认它存在）。
func (s *Service) boardIDByPublicID(ctx context.Context, q pgsql.Querier, publicID string) (int64, error) {
	id, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return 0, ErrBoardNotFound
	}
	var boardID int64
	err = pgsql.QueryRow(ctx, q, "SELECT id FROM boards WHERE public_id = $1", id.String()).Scan(&boardID)
	if err != nil {
		if errors.Is(err, pgsql.ErrNoRows) {
			return 0, ErrBoardNotFound
		}
		return 0, err
	}
	return boardID, nil
}

// invalidateUser 走 Deps 的钩子：没接线（测试台）时按「本轮无缓存」处理。
func (s *Service) invalidateUser(ctx context.Context, userID int64) error {
	if s.deps.InvalidateUser == nil {
		return nil
	}
	return s.deps.InvalidateUser(ctx, userID)
}

var _ = time.Second

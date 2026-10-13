package forum

import (
	"context"
	"strings"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// 每帖下载源上限（§7.3）。界面上一排 logo 按钮，20 个已经远超「一排」。
const maxSourcesPerTopic = 20

// ListSources 是详情里的下载源（§3.7 Q7c）。公开读，不需要登录。
func (s *Service) ListSources(ctx context.Context, topicPublicID string) ([]SourceDTO, error) {
	ref, err := s.repo.TopicRef(ctx, topicPublicID, 0, false)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	rows, err := s.repo.Sources(ctx, ref.ID)
	if err != nil {
		return nil, err
	}
	return sourceDTOs(rows), nil
}

// GoSource 是转链端点（§7.2）：只做两件事——判可见、计数——然后返回 302 的目标。
// **不做镜像探测**（现行需求里 GitHub 镜像自动寻找已废弃）：一个读接口里发 HTTP 是禁止事项，
// 而且它会让「点一下按钮」变成一次不可控的等待。限流由 handler 做（它才知道 IP）。
func (s *Service) GoSource(ctx context.Context, topicPublicID, sourcePublicID string) (string, error) {
	row, err := s.repo.SourceRef(ctx, topicPublicID, sourcePublicID)
	if err != nil {
		// 无行 / 主题不可见 → 404：**这里必须真的看不到**，否则它可以用来探测隐藏主题。
		if err == pgsql.ErrNoRows {
			return "", ErrSourceNotFound
		}
		return "", err
	}
	s.count.Add(counterSourceGoKey(row.ID), 1)
	return row.URL, nil
}

// SaveSource 是新增一条下载源（§7.3）。每帖最多 20 条。
func (s *Service) SaveSource(ctx context.Context, actor *authz.Actor, topicPublicID string, in SourceInput) (*SourceDTO, error) {
	ref, err := s.saveSourceTarget(ctx, actor, topicPublicID)
	if err != nil {
		return nil, err
	}
	clean, err := validSourceInput(in)
	if err != nil {
		return nil, err
	}
	now := s.clk.Now().UTC()
	var sourceID int64
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		n, err := s.repo.CountSources(ctx, ref.ID)
		if err != nil {
			return err
		}
		if n >= maxSourcesPerTopic {
			return invalid("url", "每个资源帖最多 20 个下载源")
		}
		id, err := pgsql.InsertSource(ctx, tx, newPublicID(), ref.ID, clean, now)
		if err != nil {
			return err
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return nil, err
	}
	row, err := s.repo.SourceByID(ctx, ref.ID, sourceID)
	if err != nil {
		return nil, err
	}
	d := sourceDTO(*row)
	return &d, nil
}

// UpdateSource 是改一条源。**改 url 时 verified_at 不动**：
// 「我确认它还有效」是一个显式动作（VerifySource），不该被改错别字顺带刷掉。
func (s *Service) UpdateSource(ctx context.Context, actor *authz.Actor, topicPublicID, sourcePublicID string, in SourceInput) (*SourceDTO, error) {
	if _, err := s.saveSourceTarget(ctx, actor, topicPublicID); err != nil {
		return nil, err
	}
	clean, err := validSourceInput(in)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.SourceByTopic(ctx, topicPublicID, sourcePublicID)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrSourceNotFound
		}
		return nil, err
	}
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return pgsql.UpdateSource(ctx, tx, row.ID, clean)
	})
	if err != nil {
		return nil, err
	}
	after, err := s.repo.SourceByTopic(ctx, topicPublicID, sourcePublicID)
	if err != nil {
		return nil, err
	}
	d := sourceDTO(*after)
	return &d, nil
}

// DeleteSource 是真删（填错了、重复了才删）。归档走 UpdateSource 的 upkeep=archived。
func (s *Service) DeleteSource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error {
	sourceID, err := s.sourceWriteTarget(ctx, actor, sourcePublicID)
	if err != nil {
		return err
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return pgsql.DeleteSource(ctx, tx, sourceID)
	})
}

// VerifySource 是「我确认它还有效」：verified_at 与 upkeep 一起变（§7.3）。
func (s *Service) VerifySource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error {
	sourceID, err := s.sourceWriteTarget(ctx, actor, sourcePublicID)
	if err != nil {
		return err
	}
	now := s.clk.Now().UTC()
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return pgsql.VerifySource(ctx, tx, sourceID, now)
	})
}

// saveSourceTarget 是新增 / 修改共用的入口判定：
// 登录 → topic.edit.own → 主题可见 → 归属（作者或管理端）→ kind=resource。
// 写下载源不判发言权：§4.1 第 4 步只覆盖「新增内容」那五条路径。
func (s *Service) saveSourceTarget(ctx context.Context, actor *authz.Actor, topicPublicID string) (*pgsql.TopicRef, error) {
	if _, err := requireActor(actor); err != nil {
		return nil, err
	}
	if err := requirePerm(actor, authz.PermTopicEditOwn); err != nil {
		return nil, err
	}
	ref, err := s.repo.TopicRef(ctx, topicPublicID, actor.UserID, canReview(actor))
	if err != nil {
		if err == pgsql.ErrNoRows {
			return nil, ErrTopicNotFound
		}
		return nil, err
	}
	if !canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, ref.AuthorID, ref.BoardID) {
		return nil, apperr.ErrForbidden
	}
	if ref.Kind != "resource" {
		return nil, ErrNotResource
	}
	return ref, nil
}

// sourceWriteTarget 是「按 source public_id 写」的入口（删除 / 确认有效）。
func (s *Service) sourceWriteTarget(ctx context.Context, actor *authz.Actor, sourcePublicID string) (int64, error) {
	if _, err := requireActor(actor); err != nil {
		return 0, err
	}
	if err := requirePerm(actor, authz.PermTopicEditOwn); err != nil {
		return 0, err
	}
	if _, err := idgen.ParsePublicID(sourcePublicID); err != nil {
		return 0, invalid("source_id", "格式不正确")
	}
	row, authorID, kind, err := s.repo.SourceRefByPublicID(ctx, sourcePublicID)
	if err != nil {
		if err == pgsql.ErrNoRows {
			return 0, ErrSourceNotFound
		}
		return 0, err
	}
	topic, err := s.repo.TopicRefByID(ctx, row.TopicID)
	if err != nil {
		return 0, err
	}
	if !canEditTopic(actor, authz.PermTopicEditOwn, authz.PermTopicDeleteAny, authorID, topic.BoardID) {
		return 0, apperr.ErrForbidden
	}
	if kind != "resource" {
		return 0, ErrNotResource
	}
	return row.ID, nil
}

// validSourceInput 是下载源的信任边界校验：
// provider 是**开放小集合**（前端按它查图标，写了 '百度' 就回落成一排问号），
// url 必须 http(s)（迁移里有同款 CHECK），提取码只收字母数字。
func validSourceInput(in SourceInput) (pgsql.SourceInput, error) {
	p := strings.TrimSpace(in.Provider)
	switch p {
	case "baidu", "aliyun", "quark", "lanzou", "pan123", "weiyun", "onedrive", "mega", "website", "github", "gitee", "other":
	default:
		return pgsql.SourceInput{}, invalid("provider", "不是已知的下载源站点")
	}
	u := strings.TrimSpace(in.URL)
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return pgsql.SourceInput{}, invalid("url", "必须是 http(s) 链接")
	}
	label := strings.TrimSpace(in.Label)
	if len([]rune(label)) > 60 {
		return pgsql.SourceInput{}, invalid("label", "长度不能超过 60")
	}
	size := strings.TrimSpace(in.Size)
	if len(size) > 16 {
		return pgsql.SourceInput{}, invalid("size", "长度不能超过 16")
	}
	var code *string
	if in.ExtractionCode != nil {
		c := strings.TrimSpace(*in.ExtractionCode)
		if c != "" {
			if len(c) > 16 || !isAlnum(c) {
				return pgsql.SourceInput{}, invalid("extraction_code", "只能是 16 位以内的字母数字")
			}
			code = &c
		}
	}
	return pgsql.SourceInput{Provider: p, Label: label, URL: u, ExtractionCode: code, SizeText: size}, nil
}

func isAlnum(s string) bool {
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		default:
			return false
		}
	}
	return true
}

package title

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/title"
	"forum/internal/ent/user"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/title/pgsql"
)

type Service struct {
	db     *ent.Client
	dbRead *ent.Client
	clk    clock.Clock
	audit  AuditSink
}

func NewService(db, dbRead *ent.Client, clk clock.Clock, audit AuditSink) *Service {
	return &Service{db: db, dbRead: dbRead, clk: clk, audit: audit}
}

// ListTitles 是目录：不返回归档的（d4 §5.3）。游客也能看。
func (s *Service) ListTitles(ctx context.Context) ([]TitleDTO, error) {
	rows, err := s.dbRead.Title.Query().
		Where(title.ArchivedAtIsNil()).
		Order(ent.Asc(title.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]TitleDTO, 0, len(rows))
	for _, t := range rows {
		out = append(out, titleDTO(t.PublicID.String(), t.Key, t.Name, t.Color, t.Description, t.ArchivedAt))
	}
	return out, nil
}

// AdminListTitles 是管理端的目录：**含归档**（D68，2026-10-15 用户实测「归档头衔管理屏看不到、
// key 被占用变永久卡死」）。归档行不进公共目录但必须能在后台看到——否则「恢复 / 删除」都无从
// 谈起，而归档一多，titles.key 的唯一列就把旧词挡成永久 409。行上 archived_at 非 nil = 已归档。
func (s *Service) AdminListTitles(ctx context.Context) ([]TitleDTO, error) {
	rows, err := s.dbRead.Title.Query().
		Order(ent.Asc(title.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]TitleDTO, 0, len(rows))
	for _, t := range rows {
		out = append(out, titleDTO(t.PublicID.String(), t.Key, t.Name, t.Color, t.Description, t.ArchivedAt))
	}
	return out, nil
}

// UserTitles 返回某人持有的**全部**头衔（含归档的徽章）+ 当前佩戴（d4 §5.3）。
func (s *Service) UserTitles(ctx context.Context, userID int64) (*UserTitlesDTO, error) {
	held, err := s.pg().UserTitles(ctx, userID)
	if err != nil {
		return nil, err
	}
	u, err := s.dbRead.User.Query().
		Where(user.IDEQ(userID)).
		Select(user.FieldEquippedTitleID).
		Only(ctx)
	if err != nil {
		return nil, err
	}
	out := &UserTitlesDTO{Items: make([]TitleDTO, 0, len(held))}
	for _, h := range held {
		out.Items = append(out.Items, titleDTO(h.PublicID, h.Key, h.Name, h.Color, h.Description, h.ArchivedAt))
		if u.EquippedTitleID != nil && *u.EquippedTitleID == h.ID {
			out.EquippedID = h.PublicID
		}
	}
	return out, nil
}

// Equip 佩戴自己持有的、未归档的头衔；"" = 取消佩戴（d4 §5.3）。
// 唯一性由 users.equipped_title_id 一个可空外键天然保证：并发两次佩戴是后写覆盖。
func (s *Service) Equip(ctx context.Context, actor *authz.Actor, titlePublicID string) error {
	if titlePublicID == "" {
		return s.db.User.UpdateOneID(actor.UserID).ClearEquippedTitleID().Exec(ctx)
	}
	if _, err := idgen.ParsePublicID(titlePublicID); err != nil {
		// 格式不对 = 他不可能持有这个头衔，与「没持有」同一条判定（d4 §4.12 ①）
		return apperr.ErrForbidden
	}
	titleID, archived, err := s.pg().HeldTitleID(ctx, actor.UserID, titlePublicID)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.ErrForbidden // 没持有的头衔：是权限式拒绝，不是参数错（d4 §7）
	}
	if err != nil {
		return err
	}
	if archived {
		return apperr.Invalid(map[string]string{"title_id": "头衔已归档，不能佩戴"})
	}
	return s.db.User.UpdateOneID(actor.UserID).SetEquippedTitleID(titleID).Exec(ctx)
}

// AssignTitle 授予 / 收回。授予幂等（已持有再授一次返回成功），
// 收回与「清掉正在佩戴的那一个」必须同事务（d4 §5.3）。
func (s *Service) AssignTitle(ctx context.Context, actor *authz.Actor, in AssignInput) error {
	if err := requirePerm(actor, authz.PermTitleGrant); err != nil {
		return err
	}
	if err := checkPublicID(in.TitlePublicID); err != nil {
		return err
	}
	titleID, _, err := s.pg().TitleByPublicID(ctx, in.TitlePublicID)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}

	if in.Revoke {
		err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
			if err := pgsql.NewTx(tx).RevokeTitle(ctx, in.UserID, titleID); err != nil {
				return err
			}
			_, err := tx.User.Update().
				Where(user.IDEQ(in.UserID), user.EquippedTitleIDEQ(titleID)).
				ClearEquippedTitleID().
				Save(ctx)
			return err
		})
		if err != nil {
			return err
		}
		return s.audit.Log(ctx, AuditEntry{
			ActorID: actor.UserID, Action: ActionTitleRevoke,
			TargetType: "user_title", TargetID: in.TitlePublicID,
			Detail: map[string]any{"user_id": in.UserID},
		})
	}

	if err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return pgsql.NewTx(tx).GrantTitle(ctx, in.UserID, titleID, actor.UserID, s.clk.Now())
	}); err != nil {
		return err
	}
	return s.audit.Log(ctx, AuditEntry{
		ActorID: actor.UserID, Action: ActionTitleGrant,
		TargetType: "user_title", TargetID: in.TitlePublicID,
		Detail: map[string]any{"user_id": in.UserID},
	})
}

func (s *Service) CreateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error) {
	if err := requirePerm(actor, authz.PermTitleManage); err != nil {
		return nil, err
	}
	in.Key = strings.TrimSpace(in.Key)
	in.Name = strings.TrimSpace(in.Name)
	if fields := validateTitle(in, true); len(fields) > 0 {
		return nil, apperr.Invalid(fields)
	}
	publicID, err := idgen.NewPublicID()
	if err != nil {
		return nil, err
	}
	t, err := s.db.Title.Create().
		SetPublicID(publicID).
		SetKey(in.Key).
		SetName(in.Name).
		SetColor(in.Color).
		SetDescription(in.Description).
		Save(ctx)
	if isUniqueViolation(err) {
		// 只有 key 是唯一列
		return nil, apperr.ErrConflict.WithFields(map[string]string{"key": "这个 key 已经有了"})
	}
	if err != nil {
		return nil, err
	}
	if err := s.audit.Log(ctx, AuditEntry{
		ActorID: actor.UserID, Action: ActionTitleManage,
		TargetType: "title", TargetID: t.PublicID.String(),
		Detail: map[string]any{"key": t.Key, "name": t.Name},
	}); err != nil {
		return nil, err
	}
	dto := titleDTO(t.PublicID.String(), t.Key, t.Name, t.Color, t.Description, t.ArchivedAt)
	return &dto, nil
}

// UpdateTitle 改 name/color/description 与归档态。**key 不可改**（改 key 等于换一个头衔）。
func (s *Service) UpdateTitle(ctx context.Context, actor *authz.Actor, in TitleInput) (*TitleDTO, error) {
	if err := requirePerm(actor, authz.PermTitleManage); err != nil {
		return nil, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if fields := validateTitle(in, false); len(fields) > 0 {
		return nil, apperr.Invalid(fields)
	}
	if err := checkPublicID(in.PublicID); err != nil {
		return nil, err
	}
	titleID, _, err := s.pg().TitleByPublicID(ctx, in.PublicID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	upd := s.db.Title.UpdateOneID(titleID).
		SetName(in.Name).
		SetColor(in.Color).
		SetDescription(in.Description)
	if in.Archived {
		upd = upd.SetArchivedAt(s.clk.Now())
	} else {
		upd = upd.ClearArchivedAt()
	}
	t, err := upd.Save(ctx)
	if ent.IsNotFound(err) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := s.audit.Log(ctx, AuditEntry{
		ActorID: actor.UserID, Action: ActionTitleManage,
		TargetType: "title", TargetID: t.PublicID.String(),
		Detail: map[string]any{"key": t.Key, "archived": in.Archived},
	}); err != nil {
		return nil, err
	}
	dto := titleDTO(t.PublicID.String(), t.Key, t.Name, t.Color, t.Description, t.ArchivedAt)
	return &dto, nil
}

// AddExp 加经验并同事务重算 level（d4 §4.13）：先插流水，只有**真的插进去了**才加经验，
// 所以队列重试与并发重放都不会加两次。ref 相同 = 同一次事件。
// DeleteTitle 是**真删**（D68 的第二根：归档项在后台不可见且删不了，key 唯一列被旧词占用后
// 新建立刻 409，「永久卡死」）。titles 被引用时外键会级联毁掉 user_titles 的历史行、把佩戴置空
// （0009 的 ON DELETE SET NULL/CASCADE）——那是「数据不许悄悄毁掉」的反例，所以删除前在同一
// 事务里数一遍引用：有人在持有 / 佩戴就 409 并把数量说在 fields 里，收回之后才放行。
func (s *Service) DeleteTitle(ctx context.Context, actor *authz.Actor, titlePublicID string) error {
	if err := requirePerm(actor, authz.PermTitleManage); err != nil {
		return err
	}
	if err := checkPublicID(titlePublicID); err != nil {
		return err
	}
	titleID, _, err := s.pg().TitleByPublicID(ctx, titlePublicID)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		q := pgsql.NewTx(tx)
		var holders, equipped int
		if err := q.TitleRefs(ctx, titleID, &holders, &equipped); err != nil {
			return err
		}
		if holders > 0 || equipped > 0 {
			msg := ""
			switch {
			case holders > 0 && equipped > 0:
				msg = fmt.Sprintf("还有 %d 人持有、%d 人正佩戴这条头衔，先收回再删除", holders, equipped)
			case holders > 0:
				msg = fmt.Sprintf("还有 %d 人持有这条头衔，先收回再删除", holders)
			default:
				msg = fmt.Sprintf("还有 %d 人正佩戴这条头衔，先取下再删除", equipped)
			}
			return apperr.ErrConflict.WithFields(map[string]string{"title_id": msg})
		}
		return tx.Title.DeleteOneID(titleID).Exec(ctx)
	}); err != nil {
		return err
	}
	return s.audit.Log(ctx, AuditEntry{
		ActorID: actor.UserID, Action: ActionTitleManage,
		TargetType: "title", TargetID: titlePublicID,
		Detail: map[string]any{"deleted": true},
	})
}

func (s *Service) AddExp(ctx context.Context, actor *authz.Actor, in AddExpInput) (*ExpDTO, error) {
	if err := requirePerm(actor, authz.PermTitleGrant); err != nil {
		return nil, err
	}
	if fields := validateExp(in); len(fields) > 0 {
		return nil, apperr.Invalid(fields)
	}
	var out ExpDTO
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		q := pgsql.NewTx(tx)
		inserted, err := q.InsertExpEvent(ctx, in.UserID, in.Delta, in.Reason, in.Ref, s.clk.Now())
		if err != nil {
			return err
		}
		if !inserted {
			out.Exp, out.Level, err = q.CurrentExp(ctx, in.UserID)
			return err
		}
		out.Exp, out.Level, err = q.AddExp(ctx, in.UserID, in.Delta, s.clk.Now())
		return err
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Service) pg() *pgsql.Queries { return pgsql.New(s.db) }

// checkPublicID：格式不对的 public_id 等同于「找不到」（否则 PG 的 22P02 会变成 500）。
func checkPublicID(s string) error {
	if _, err := idgen.ParsePublicID(s); err != nil {
		return apperr.ErrNotFound
	}
	return nil
}

// isUniqueViolation 把 PG 的 23505 认出来：titles.key 撞车要变成 409，而不是 500。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// requirePerm：危险写操作在 service 层再兜一次（拍板 §5.3）——队列 / CLI 不走路由，
// 路由中间件拦不到它们；测试也直接调 service（d4 §8.3）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor.IsSuper || actor.Perms.Has(perm) {
		return nil
	}
	return apperr.ErrForbidden
}

func validateTitle(in TitleInput, withKey bool) map[string]string {
	fields := map[string]string{}
	if withKey && !keyRe.MatchString(in.Key) {
		fields["key"] = "只能是小写字母、数字、下划线，1-32 位"
	}
	if in.Name == "" {
		fields["name"] = "不能为空"
	}
	if len([]rune(in.Name)) > 32 {
		fields["name"] = "不能超过 32 字"
	}
	if in.Color != "" && !colorRe.MatchString(in.Color) {
		fields["color"] = "必须是 #rrggbb"
	}
	if len([]rune(in.Description)) > 200 {
		fields["description"] = "不能超过 200 字"
	}
	return fields
}

func validateExp(in AddExpInput) map[string]string {
	fields := map[string]string{}
	if in.Delta == 0 {
		fields["delta"] = "不能为 0"
	}
	if _, ok := expReasons[in.Reason]; !ok {
		fields["reason"] = "不支持的来源"
	}
	if in.Ref != "" && !refRe.MatchString(in.Ref) {
		fields["ref"] = "形状是 <实体>:<内部id>，例如 post:42"
	}
	return fields
}

var (
	keyRe   = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	refRe   = regexp.MustCompile(`^[a-z_]+:[0-9]+$`)
)

var expReasons = map[string]bool{
	ReasonManual: true, ReasonRegister: true, ReasonTopic: true, ReasonReply: true,
	ReasonLike: true, ReasonReward: true, ReasonImport: true,
}

func titleDTO(publicID, key, name, color, description string, archivedAt *time.Time) TitleDTO {
	return TitleDTO{ID: publicID, Key: key, Name: name, Color: color, Description: description, ArchivedAt: archivedAt}
}

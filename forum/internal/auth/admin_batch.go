package auth

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 批量操作用户（交接单 C6：§5.1 的「勾一批 → 一次处理」）。
//
// **逐条独立**是这一块的唯一要点：一个事务里全成功全失败会让管理员发疯
// （批量停用 20 个人，其中一个恰好是最后一名超管，整批就白点了）。
// 所以每条走自己的事务（BanUser / ActivateUser / SetUserRole 本来就是那个形状），
// 一条失败只写进它自己的结果行，其余照常执行。
//
// 代价写在明处：**不是原子的** —— 返回 200 不等于「全都做了」，
// 调用方必须读 items[] 里每一条的 ok。顶层给 succeeded / failed 两个计数，
// 前端不需要自己数一遍（数错了就会显示「全部成功」）。

// 批量动作的值域。四个动作都走**单条端点的同一套实现**，不另写一份语义。
const (
	BatchActionBan      = "ban"
	BatchActionUnban    = "unban"
	BatchActionActivate = "activate"
	BatchActionSetRole  = "set_role"
)

// maxBatchUsers 是一次最多处理多少条：一次请求就是一百次审计写，再大失败重试的代价不可控。
const maxBatchUsers = 100

var batchActions = map[string]bool{
	BatchActionBan: true, BatchActionUnban: true, BatchActionActivate: true, BatchActionSetRole: true,
}

// BatchUsersInput 是 POST /admin/users/batch 的入参。
type BatchUsersInput struct {
	IDs    []string
	Action string
	RoleID int64  // 只有 set_role 用
	Reason string // ban 用（进审计）
	IP     string
}

// BatchItemResult 是一条的结果。ok=false 时 Error 一定非空 ——
// 「静默跳过」是这类接口最坏的形态：管理员以为处理了，实际一个人都没动。
type BatchItemResult struct {
	ID    string           `json:"id"`
	OK    bool             `json:"ok"`
	Error *BatchItemErrors `json:"error"`
}

// BatchItemErrors 与 httpx 的错误体同形（code + message）：整批的结果并排显示时，
// 每行的失败原因与单条端点看到的是同一句话。
type BatchItemErrors struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// BatchUsersResult 是整批的结果。
type BatchUsersResult struct {
	Total     int               `json:"total"`
	Succeeded int               `json:"succeeded"`
	Failed    int               `json:"failed"`
	Items     []BatchItemResult `json:"items"`
}

// BatchUsers 逐条执行。
func (s *Service) BatchUsers(ctx context.Context, actor *authz.Actor, in BatchUsersInput) (*BatchUsersResult, error) {
	if err := requirePerm(actor, authz.PermUserBan); err != nil {
		return nil, err
	}
	action := strings.TrimSpace(in.Action)
	if !batchActions[action] {
		return nil, invalid("action", "只能是 ban / unban / activate / set_role")
	}
	if len(in.IDs) == 0 {
		return nil, invalid("ids", "至少要给一个用户")
	}
	if len(in.IDs) > maxBatchUsers {
		return nil, invalid("ids", "一次最多 "+strconv.Itoa(maxBatchUsers)+" 个用户")
	}
	out := &BatchUsersResult{Total: len(in.IDs), Items: make([]BatchItemResult, 0, len(in.IDs))}
	for _, id := range in.IDs {
		item := BatchItemResult{ID: id}
		if err := s.batchOne(ctx, actor, action, id, in); err != nil {
			item.Error = batchItemError(err)
			out.Failed++
		} else {
			item.OK = true
			out.Succeeded++
		}
		out.Items = append(out.Items, item)
	}
	return out, nil
}

// batchOne 分发到单条端点的同一套实现。**不复制语义**：
// 封号仍然走 guardLastSuper，改角色仍然要求 role.assign ——
// 批量的意思是「少点几次」，不是「换一套宽松的规则」。
func (s *Service) batchOne(ctx context.Context, actor *authz.Actor, action, publicID string, in BatchUsersInput) error {
	switch action {
	case BatchActionBan:
		_, err := s.BanUser(ctx, actor, BanInput{UserPublicID: publicID, Action: "ban", Reason: in.Reason, IP: in.IP})
		return err
	case BatchActionUnban:
		_, err := s.BanUser(ctx, actor, BanInput{UserPublicID: publicID, Action: "unban", Reason: in.Reason, IP: in.IP})
		return err
	case BatchActionActivate:
		return s.ActivateUser(ctx, actor, publicID, in.IP)
	case BatchActionSetRole:
		if in.RoleID == 0 {
			return invalid("role_id", "set_role 必须给 role_id")
		}
		return s.SetUserRole(ctx, actor, SetUserRoleInput{UserPublicID: publicID, RoleID: in.RoleID, IP: in.IP})
	}
	return invalid("action", "只能是 ban / unban / activate / set_role")
}

// batchItemError 把 error 压成 {code, message}：本域的错误都是 *apperr.Error，
// 其余（数据库故障等）只给一句通用码，细节留在日志里（与 httpx.Fail 的口径一致）。
func batchItemError(err error) *BatchItemErrors {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		return &BatchItemErrors{Code: ae.Code, Message: ae.Msg}
	}
	return &BatchItemErrors{Code: apperr.CodeInternal, Message: "操作失败，请稍后再试"}
}

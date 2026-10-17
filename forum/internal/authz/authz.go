// Package authz 是**授权的唯一真源**：权限点常量、Actor、以及三个判定函数。
//
// 三条硬规则（后端方案 §9.8 / 拍板 §1）：
//  1. 权限点在代码里，不在数据库里（数据库只存 key 的镜像，用于启动自检）；
//  2. 超管短路必须放在权限集合之前，否则以后新增权限点时超管会被自己拦住；
//  3. 作用域权限（board.moderate）与资源归属判定**不进中间件**，只在 service 层判。
package authz

import "sort"

// 权限点全集：24 个（拍板 §1.2 + §10.9 定案：topic.pin 兼管精华，不设 topic.feature）。
// 新增一个 = 加常量 + 加迁移往 permissions 表插一行 + 写穿给内置角色；启动自检会对比两边。
const (
	// 内容
	PermTopicCreate     = "topic.create" // 发主题、发回复、发 issue、发 issue 评论（同一个点管四件事）
	PermTopicEditOwn    = "topic.edit.own"
	PermTopicDeleteOwn  = "topic.delete.own"
	PermTopicDeleteAny  = "topic.delete.any"
	PermTopicLock       = "topic.lock"
	PermTopicPin        = "topic.pin" // 置顶**与**精华（两个端点同一个点，见拍板 §10.9）
	PermTopicMove       = "topic.move"
	PermResourcePublish = "resource.publish" // 发 kind=resource 的主题时额外要它
	// 分区
	PermBoardManage   = "board.manage"
	PermBoardModerate = "board.moderate" // 作用域：只在 board_moderators 命中的分区内生效
	// 内容治理
	PermPostReview   = "post.review"
	PermReportHandle = "report.handle"
	// 用户与权限
	PermUserBan         = "user.ban"
	PermUserMute        = "user.mute"
	PermRoleEdit        = "role.edit"
	PermRoleAssign      = "role.assign"
	PermPermissionGrant = "permission.grant"
	// 头衔
	PermTitleGrant  = "title.grant"
	PermTitleManage = "title.manage"
	// 站点与运营
	PermRewardVerify = "reward.verify"
	PermMailManage   = "mail.manage"
	PermSiteSetting  = "site.setting"
	// 审计
	PermAuditView   = "audit.view"
	PermAuditExport = "audit.export"
)

// All 是权限点的全集，顺序即迁移 0017 的插入顺序。
// 启动自检用它对比 permissions 表：表里少 → 拒绝启动；表里多 → Warn（那是可删的死权限点）。
var All = []string{
	PermTopicCreate, PermTopicEditOwn, PermTopicDeleteOwn, PermTopicDeleteAny,
	PermTopicLock, PermTopicPin, PermTopicMove, PermResourcePublish,
	PermBoardManage, PermBoardModerate,
	PermPostReview, PermReportHandle,
	PermUserBan, PermUserMute, PermRoleEdit, PermRoleAssign, PermPermissionGrant,
	PermTitleGrant, PermTitleManage,
	PermRewardVerify, PermMailManage, PermSiteSetting,
	PermAuditView, PermAuditExport,
}

// Set 是权限集合。用 map 而不是 slice：判成员是热路径（每个请求都要走一次）。
type Set map[string]struct{}

func NewSet(keys ...string) Set {
	s := make(Set, len(keys))
	for _, k := range keys {
		s[k] = struct{}{}
	}
	return s
}

func (s Set) Has(perm string) bool { _, ok := s[perm]; return ok }

// HasAll 是中间件 Perm(a, b) 的语义：默认 AND。需要 OR 用 HasAny。
func (s Set) HasAll(perms ...string) bool {
	for _, p := range perms {
		if !s.Has(p) {
			return false
		}
	}
	return true
}

func (s Set) HasAny(perms ...string) bool {
	for _, p := range perms {
		if s.Has(p) {
			return true
		}
	}
	return false
}

// Keys 是集合的排序副本：/me 的 perms 与审计的 before/after 都要稳定顺序，
// 否则同一份权限两次序列化出来的 JSON 不一样，前端做 diff 会出现假变更。
func (s Set) Keys() []string {
	out := make([]string, 0, len(s))
	for k := range s {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Actor 是判定需要的最小身份。service 方法**显式接收它**，不从 context 取（拍板 §5.3）。
// 字段刻意只有判定需要的：不带 Perms 的原始列表、不带 session token。
type Actor struct {
	UserID        int64
	PublicID      string
	Perms         Set
	BoardIDs      []int64 // 他是版主的分区（board.moderate 的作用域来源）
	RoleID        int64
	RoleKey       string // **只用于展示与审计**，判定一律走权限点（后端方案 §9.8 禁止比较角色字符串）
	RoleName      string
	RoleBadge     string
	IsSuper       bool
	EmailVerified bool
	Activated     bool
	Status        string // active / banned / deleted
}

// CanInBoard 只回答「是不是这个分区的版主」。分区发言 ACL 由 forum 查 board_acls 后按拍板 §1.5 的六步判。
func CanInBoard(a *Actor, boardID int64) bool {
	if a == nil {
		return false
	}
	if a.IsSuper {
		return true
	}
	for _, id := range a.BoardIDs {
		if id == boardID {
			return true
		}
	}
	return false
}

// Package follow 是「关注」：关注分区与关注用户（拍板 L5，2026-10-14）。
//
// 它**只做关注关系本身**：表 + 端点 + 幂等 + 列表。
// 「关注之后的推送」拍板明说「暂时不需要,算备用」，所以本域一行通知都不发
// （没有 notify:* 任务类型、没有通知类别、没有 dedup）。
//
// 两种对象在一张表里（迁移 0040 的 ck_follows_target：user_id / board_id 恰好一个非空）：
// 「我关注了什么」这一问只有一个答案，列表与统计因此各只有一份实现。
package follow

import "time"

// Target 是「关注什么」。值域即迁移 0040 的两个列名。
const (
	TargetUser  = "user"
	TargetBoard = "board"
)

// State 是「这一格现在该显示什么」：某人 / 某分区被关注了多少次，以及**我**有没有关注它。
// 它是所有关注端点的回执形状 —— 关注、取关、读状态三条路回同一份，前后端各只认一种形状。
type State struct {
	Target        string `json:"target"`
	Slug          string `json:"slug,omitempty"`   // target=board：分区 slug
	Handle        string `json:"handle,omitempty"` // target=user：被关注者的 handle
	Following     bool   `json:"following"`        // **我**有没有关注（未登录恒 false）
	FollowerCount int    `json:"follower_count"`
}

// UserItem 是关注者 / 我关注的人列表里的一行。
// 形状与 forum 的 UserBriefDTO（handle/nickname/avatar_hash/avatar_small_hash）**同名同义**：
// 同一个头像在站内只有一种拼法（裸哈希，前端拼 /img/<hash>），多一套字段名就会多一处漂移。
type UserItem struct {
	PublicID    string    `json:"id"`
	Handle      string    `json:"handle"`
	Nickname    string    `json:"nickname"`
	AvatarHash  string    `json:"avatar_hash"`
	AvatarSmall string    `json:"avatar_small_hash"`
	FollowedAt  time.Time `json:"followed_at"`
}

// BoardItem 是「我关注的分区」列表里的一行。
type BoardItem struct {
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CoverHash   string    `json:"cover_hash"`
	FollowedAt  time.Time `json:"followed_at"`
}

// ListInput 是三个列表端点的入参（游标 + 条数，与别域同一套）。
type ListInput struct {
	Cursor string
	Limit  int
}

// UserPage / BoardPage 是一页（`{ data, next_cursor }`，走 httpx.OKList）。
type UserPage struct {
	Items      []UserItem
	NextCursor string
}

type BoardPage struct {
	Items      []BoardItem
	NextCursor string
}

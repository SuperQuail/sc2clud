package message

import "time"

type PageInput struct {
	Cursor string
	Limit  int
}

type ThreadInput struct {
	PeerHandle string
	Cursor     string
	Limit      int
}

type SendInput struct {
	PeerHandle string
	Body       string
}

type ConversationPage struct {
	Items      []ConversationDTO
	NextCursor string // "" = 到底
}

type ConversationDTO struct {
	Peer        UserBrief  `json:"peer"`
	UnreadCount int        `json:"unread_count"`
	Last        MessageDTO `json:"last"`
}

type ThreadPage struct {
	Peer       UserBrief
	Items      []MessageDTO
	NextCursor string
}

// MessageDTO：mine = 我发的；read = **收件人**已读（我发的那条由对方读）。
type MessageDTO struct {
	ID        string    `json:"id"`
	Body      string    `json:"body"`
	Mine      bool      `json:"mine"`
	Read      bool      `json:"read"`
	CreatedAt time.Time `json:"created_at"`
}

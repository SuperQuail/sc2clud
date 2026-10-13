package site

import (
	"encoding/base64"
	"encoding/json"
	"time"

	"forum/internal/platform/apperr"
)

// 分页上限与默认值（拍板 §5.1：limit 默认 20、上限 100，多取一条判到底）。
const (
	defaultLimit = 20
	maxLimit     = 100
)

// CursorInput 是列表端点的公共查询串（limit + cursor）。
type CursorInput struct {
	Limit  int    `form:"limit"`
	Cursor string `form:"cursor"`
}

// cursor 是拍板 §5.1 的游标：排序键 + id 兜底（并列或 NULL 时不会跨页重复/漏项）。
type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}

func encodeCursor(t time.Time, id int64) string {
	b, err := json.Marshal(cursor{T: t.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor 解不出就是 400：伪造的游标不该被当成「第一页」静默吞掉。
func decodeCursor(s string) (*cursor, error) {
	if s == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errBadCursor
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errBadCursor
	}
	return &c, nil
}

var errBadCursor = apperr.ErrInvalidInput.WithFields(map[string]string{"cursor": "游标格式不正确"})

func limitOf(n int) int {
	switch {
	case n <= 0:
		return defaultLimit
	case n > maxLimit:
		return maxLimit
	default:
		return n
	}
}

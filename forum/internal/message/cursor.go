package message

import (
	"encoding/base64"
	"encoding/json"

	"forum/internal/platform/apperr"
)

// 会话列表与会话内的游标 = base64url(JSON{id})：两条查询的排序键都是 id（消息 id 单调），
// 所以不需要第二个排序键（拍板 §5.1 的「排序键带 id 兜底」在这里退化成只看 id）。
type cursorPayload struct {
	ID int64 `json:"id"`
}

func encodeCursor(id int64) string {
	b, err := json.Marshal(cursorPayload{ID: id})
	if err != nil {
		panic(err) // 只有一个整数，序列化不可能失败
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, errBadCursor
	}
	var p cursorPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0, errBadCursor
	}
	return p.ID, nil
}

var errBadCursor = apperr.Invalid(map[string]string{"cursor": "游标无效"})

package notify

import (
	"encoding/base64"
	"encoding/json"
	"time"

	"forum/internal/platform/apperr"
)

// 游标 = base64url(JSON{k:<created_at RFC3339Nano>, id:<内部 id>})，排序键永远带 id 兜底（拍板 §5.1）。
// id 只用于并列时定位，不出现在响应里。
type cursorPayload struct {
	K  string `json:"k"`
	ID int64  `json:"id"`
}

func encodeCursor(createdAt time.Time, id int64) string {
	b, err := json.Marshal(cursorPayload{K: createdAt.UTC().Format(time.RFC3339Nano), ID: id})
	if err != nil {
		// 只含一个字符串与一个整数，序列化不可能失败；真失败了说明内存已经坏了
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, errBadCursor
	}
	var p cursorPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return time.Time{}, 0, errBadCursor
	}
	k, err := time.Parse(time.RFC3339Nano, p.K)
	if err != nil {
		return time.Time{}, 0, errBadCursor
	}
	return k.UTC(), p.ID, nil
}

var errBadCursor = apperr.Invalid(map[string]string{"cursor": "游标无效"})

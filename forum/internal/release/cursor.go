package release

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"time"

	"forum/internal/platform/apperr"
)

// 游标是服务端自己发给自己的一串：base64url(JSON{k,id})。
// k 用 UnixNano（整数，无时区与小数歧义），id 是内部 bigint，两者一起构成行序比较的右端。
type cursor struct {
	K  int64 `json:"k"`
	ID int64 `json:"id"`
}

const (
	defaultLimit = 20
	maxLimit     = 100
)

// firstPage 是第一页的哨兵：9999 年 + MaxInt64 大于任何真实值，
// 于是 (published_at, id) < (k, id) 在第一页恒真，而 WHERE 里仍然留着那个行比较。
var (
	sentinelTime = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
	sentinelID   = int64(math.MaxInt64)
)

func encodeCursor(t time.Time, id int64) string {
	b, err := json.Marshal(cursor{K: t.UnixNano(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor 解不开就是 400：伪造的游标不该被当成「第一页」静默吞掉。
func decodeCursor(s string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, badCursor()
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, 0, badCursor()
	}
	return time.Unix(0, c.K).UTC(), c.ID, nil
}

func badCursor() error {
	return apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
}

// pageCursor 把入参游标解成 (k,id)；空游标 = 第一页的哨兵。
func pageCursor(s string) (time.Time, int64, error) {
	if s == "" {
		return sentinelTime, sentinelID, nil
	}
	return decodeCursor(s)
}

package forum

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"forum/internal/platform/apperr"
)

// 游标是**服务端自己发给自己**的不透明串（§3.8）：base64url(JSON{k,id})。
//   - k 是排序键的字符串形式（时间用 RFC3339Nano）——JSON 数字在 float64 与 int64 之间会丢精度，
//     而 bigint 主题 id 早过了 2^53，所以统一成字符串；
//   - id 是**内部 bigint**，不是 public_id：游标要在 WHERE 里直接比大小，用 public_id 就得回查一行。
//     它永远不出现在响应里（响应只有 public_id），所以「自增 id 不出 API」仍然成立。
type cursor struct {
	K  string `json:"k"`
	ID int64  `json:"id"`
}

// 分页条数的默认与上限。前端不传就用默认；传大了收敛到上限——
// 不做「400 拒绝」，因为条数是展示偏好，不是契约。
const (
	defaultLimit = 20
	maxLimit     = 50
)

// firstPage 是第一页的哨兵。**禁止传 NULL**：行比较遇 NULL 会让整条谓词变 NULL，
// 静默返回零行（§3.8 规则 2）。9999 年与 MaxInt64 都大于任何真实值，所以
// (k,id) < (sentinel) 在第一页恒真，而 WHERE 里仍然留着那个行比较、索引条件不变。
var (
	sentinelTime = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
	sentinelID   = int64(math.MaxInt64)
)

func encodeCursor(k time.Time, id int64) string {
	b, err := json.Marshal(cursor{K: k.UTC().Format(time.RFC3339Nano), ID: id})
	if err != nil {
		// json.Marshal 对一个两个字段的结构体不会失败；真失败了也不能把它变成 500
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor 解不开就是 400 common.invalid_input：伪造的游标不该被当成「第一页」静默吞掉。
func decodeCursor(s string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, badCursor()
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, 0, badCursor()
	}
	t, err := time.Parse(time.RFC3339Nano, c.K)
	if err != nil {
		return time.Time{}, 0, badCursor()
	}
	return t.UTC(), c.ID, nil
}

func badCursor() error {
	return apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
}

// pageCursor 把列表入参的游标解成 (k,id)。空游标 = 第一页的哨兵。
func pageCursor(s string) (time.Time, int64, error) {
	if s == "" {
		return sentinelTime, sentinelID, nil
	}
	return decodeCursor(s)
}

// intCursor 是只按 id 翻页的列表（回复、楼中楼、Issue 评论）。
func intCursor(s string) (int64, error) {
	if s == "" {
		return sentinelID, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, badCursor()
	}
	var c cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return 0, badCursor()
	}
	return c.ID, nil
}

func encodeIntCursor(id int64) string {
	b, err := json.Marshal(cursor{K: strconv.FormatInt(id, 10), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// limitOf 把请求里的 limit 收敛到 [1, maxLimit]；不传用 defaultLimit。
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

// nextCursor 只在「取到了 limit 条」时才给下一页游标（§3.8 规则 3）：
// 少于 limit 就是到底，响应给 null。想精确判断可以多查一行，但那多一次「丢最后一行」的机会。
func nextCursor[T any](rows []T, limit int, ref func(T) (time.Time, int64)) string {
	if len(rows) < limit {
		return ""
	}
	return encodeCursor(ref(rows[len(rows)-1]))
}

func nextIntCursor[T any](rows []T, limit int, ref func(T) int64) string {
	if len(rows) < limit {
		return ""
	}
	return encodeIntCursor(ref(rows[len(rows)-1]))
}

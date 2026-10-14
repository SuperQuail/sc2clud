package forum

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"forum/internal/forum/pgsql"
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

// sentinelTimeAsc 是**升序**列表（Issue 的 sort=old）第一页的哨兵，与 sentinelID 的用法成对。
//
// 为什么升序不能复用 sentinelTime：第一页的判据是「键在哨兵之后」——
// 降序是 key < 9999，升序就得是 key > 0001。用 9999 的话升序第一页恒假、**永远返回零行**
// （这是「第一页」这件事唯一的方向性，看代码看不出来，只有用例能钉住）。
var sentinelTimeAsc = time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)

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

// badCursor 是全部游标解码失败的唯一出口：400 common.invalid_input，
// **不是**「当成第一页静默吞掉」——伪造的游标是客户端 bug 或攻击，不该看不出来。
func badCursor() error {
	return apperr.Invalid(map[string]string{"cursor": "游标格式不正确"})
}

// ---- 最热（sort=hot）的游标（拍板 08 · L2）----
//
// 为什么不能复用上面那条：`cursor.K` 是 **RFC3339Nano 的时间戳** —— 现有三种排序的键
// 都是时间列（last_reply_at / created_at / featured_at），游标比较直接写
// `(col, id) < ($k::timestamptz, $id::bigint)`。最热的键**不是时间**，是
// `score = (like_count + 3*顶层评论数) * time_boost`，而 time_boost 依赖 now()，
// 所以键必须由服务端算好放进游标，客户端不能推、也不能拿时间字段冒充。
//
// 编码成字符串而不是 float64：JSON 数字在 float64 与 numeric 之间来回会丢精度，
// 而 k 要直接进 `::numeric` 比较（与 id 那条「bigint 不出 JSON number」的取舍同源）。
type hotCursor struct {
	K  string `json:"k"`
	ID int64  `json:"id"`
}

func encodeHotCursor(k string, id int64) string {
	b, err := json.Marshal(hotCursor{K: k, ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeHotCursor(s string) (string, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", 0, badCursor()
	}
	var c hotCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", 0, badCursor()
	}
	if _, err := strconv.ParseFloat(c.K, 64); err != nil {
		return "", 0, badCursor()
	}
	return c.K, c.ID, nil
}

// hotFirstPage 是第一页的哨兵。**禁止传 NULL**（与 sentinelTime 同一条纪律）。
// 它必须大于任何真实分数：epoch 秒的上界约 1e11，乘 1.5 的增益再乘不上限的互动量 ——
// 1e300 是「比任何 LISTEN 得到的数都大」的一个安全上界。
const hotFirstPage = "1e300"

// hotPageCursor 把列表入参的游标解成 (score,id)。空游标 = 第一页的哨兵。
func hotPageCursor(s string) (string, int64, error) {
	if s == "" {
		return hotFirstPage, sentinelID, nil
	}
	return decodeHotCursor(s)
}

// hotNextCursor 只在「取到了 limit 条」时才给下一页游标（§3.8 规则 3），与 nextCursor 同一条规则。
//
// 分数用 strconv.FormatFloat(-1) 而不是 %v：-1 是「最短且能往返」的表示。
// 游标是服务端自己发给自己，只要往返后 ::numeric 比较的序不变就够（float64 的 17 位有效数字
// 远够 1e11 量级的分辨）。**不要**改成手写精度：那会让「比较」与「展示」两处各有一套四舍五入。
func hotNextCursor(rows []pgsql.TopicRow, limit int) string {
	if len(rows) < limit {
		return ""
	}
	last := rows[len(rows)-1]
	return encodeHotCursor(strconv.FormatFloat(last.HotKey, 'g', -1, 64), last.ID)
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

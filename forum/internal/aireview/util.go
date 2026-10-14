package aireview

import (
	"encoding/json"
	"strconv"

	"forum/internal/report"
)

// d7 §6：priority=20（高于验证码邮件 10 —— 用户可以晚几秒收到信，但审核晚几秒他就在看「审核中」）、
// max_retry=2（重试太久没意义，第 3 次直接交人工）。
const (
	priorityReview = 20
	maxRetryReview = 2
)

// payloadJSON 是 ai:review 的 payload：{topic_id, trigger}（d7 §6 的最小形状）。
func payloadJSON(topicID int64, trigger string) string {
	b, err := json.Marshal(map[string]any{"topic_id": topicID, "trigger": trigger})
	if err != nil {
		// 两个标量序列化不了就是代码 bug；返回空对象让任务解 payload 失败时 SkipRetry，不阻塞队列。
		return "{}"
	}
	return string(b)
}

// trimRunes 按**字符**截断：列宽按字符算（varchar(200)），按字节截会把一个汉字砍成半个。
func trimRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func itoa(n int) string { return strconv.Itoa(n) }

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// 编译期断言：Service 满足举报域的复核触发口（接线时 report.NewService 收到它）。
var _ report.ReviewTrigger = (*Service)(nil)

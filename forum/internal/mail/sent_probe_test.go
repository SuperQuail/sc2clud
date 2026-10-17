package mail_test

import (
	"encoding/json"
	"strings"
)

// sentMail 是 logProvider 那条投递事件里截出来的整封信。
type sentMail struct{ Subject, HTML, Text string }

// sentMailMsg 与 platform/mail 的 logProvider 文案逐字一致（链路关键点换了位置先改这条）。
const sentMailMsg = "mail: log provider 投递（仅 dev/测试）"

// sent 把测试期间经真投递链（tasks.go render → Router → log provider）发出的信按序捞出。
func (h *harness) sent() []sentMail {
	var out []sentMail
	for _, line := range strings.Split(h.mailLog.String(), "\n") {
		if line == "" {
			continue
		}
		var rec struct {
			Msg     string `json:"msg"`
			Subject string `json:"subject"`
			HTML    string `json:"html"`
			Text    string `json:"text"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil || rec.Msg != sentMailMsg {
			continue
		}
		out = append(out, sentMail{Subject: rec.Subject, HTML: rec.HTML, Text: rec.Text})
	}
	return out
}

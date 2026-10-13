// Package mention 解析与校验 Markdown 正文里的 @提及。
//
// 存储格式是**标准 Markdown 链接** [@昵称](mention:<user_id>)（v2 §9.7）：别的渲染器不认识
// mention: 协议时会退化成普通链接，比自定义 token 好互操作。
// user_id 是唯一真源（跳转 / 通知 / 拉黑判定都用它），昵称只是写入时的快照。
//
// 渲染（把 mention: 链接改写成 <a href="/u/<id>">）在 platform/markdown 里，
// 因为它必须发生在清洗流水线的固定位置上。
package mention

import (
	"regexp"
	"strconv"
)

// BodyRe 匹配一条提及，与 d4 §5.6 的 Re 逐字一致。
var BodyRe = regexp.MustCompile(`[\@([^\]\n]{1,20})\](mention:(\d{1,18})\)`)

// MaxPerBody 是单条正文的提及上限（v2 §9.7）。
const MaxPerBody = 20

// Parse 按出现顺序取出被提及的 user_id，按 id 去重；不查库。
//
// 超过 100KB 的部分不看：单条正文的入口上限就一万字，更长的串里不可能有有效提及，
// 而正则在超长无匹配串上会扫完整个长度。
func Parse(md string) []int64 {
	if len(md) > 100<<10 {
		md = md[:100<<10]
	}
	var (
		ids  []int64
		seen = map[int64]bool{}
	)
	for _, m := range BodyRe.FindAllStringSubmatch(md, -1) {
		id, err := strconv.ParseInt(m[2], 10, 64)
		if err != nil || id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

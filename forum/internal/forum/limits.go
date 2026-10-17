package forum

import "strconv"

// 正文长度上限，**按字符数**（不是字节）。
//
// 帖子 2 万字、回复 8 千字 —— 这两档是**老站（Rust 版）就有的设计**，不是这里新定的；
// 上限卡在**写入边界**（创建与编辑），而不是等到发给模型时再截断：
// 截断只是把超长内容变成「模型看到的比用户发的少」，违规内容照样发得出去。
const (
	MaxTopicContent = 20000
	MaxPostContent  = 8000
)

// checkContentLen 按**字符**数卡上限。
//
// 用 rune 不用 byte：一个汉字 3 字节，按字节卡会把中文用户的上限砍到三分之一
// （项目里已经栽过一次同类的账：昵称校验一边按 rune、一边按字节）。
func checkContentLen(content string, max int, field string) error {
	if n := len([]rune(content)); n > max {
		return invalid(field, "最多 "+strconv.Itoa(max)+" 个字，现在是 "+strconv.Itoa(n)+" 个")
	}
	return nil
}

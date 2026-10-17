package aireview

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本域的错误码。**只在这里定义**（v2 §21.4：handler 不许自己造码）。
//
// D33③ 新增的这一个：带帖试跑要用**真字节**去组装 payload，而配图可能读不到
// （行在文件丢 / 解码失败）。那时不能给一个"看起来跑通了"的回执 —— 回执是拿来看结论的，
// 少了几张图的结论比没有结论更危险。所以它是一条**显式错误**，不是一个空结果。
//
// 注意它只属于「试跑」这条路：真判定那条路遇到读不到会**转人工**（不返回错误 —— 返回错误会让
// 队列反复重试同一件读不到的事），见 images.go 的 loadImages 与 service.go 的 ReviewTopic。
var errImageUnreadable = apperr.New("ai.image_unreadable", http.StatusInternalServerError,
	"配图读不到，这条帖子的试跑结果不可信")

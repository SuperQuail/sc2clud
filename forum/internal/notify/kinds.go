package notify

// 通知类别常量。取值必须与迁移 0007 的 ck_notifications_type 逐字相同
// （pg_constraint 的自检会比对两边，见 kinds_test.go）。
const (
	KindReply    = "reply"    // 回复了我的主题 / 楼层
	KindMention  = "mention"  // 正文里 @了我
	KindLike     = "like"     // 赞了我的主题 / 楼层 / issue 评论
	KindReward   = "reward"   // 打赏到账
	KindReview   = "review"   // 主题审核结果
	KindSanction = "sanction" // 被禁言
	KindSystem   = "system"   // 系统通知
	// KindLink 只用于 notification_mutes.type：整条内容不再通知（不是通知类别）
	KindLink = "link"
)

// 引用类型（payload.ref_type / dedup_key 前缀 / 静音 target_key 前缀三处同源）。
// 取值必须与 ck_notifications_dedup_prefix 的白名单逐字相同。
const (
	RefPost     = "post"
	RefTopic    = "topic"
	RefComment  = "comment" // issue 评论
	RefIssue    = "issue"
	RefDonation = "donation"
	RefSanction = "sanction"
	RefSystem   = "system"
)

// 队列任务类型：notify 的全部入队点（d4 §5.1 的 ①–⑥）。
// 契约常量在 platform/queue/types.go，但那两个已存在的名字之外还差四个；
// 本模块的写作用域不含 platform/**，所以六个都在这份文件里一处定义，
// 取值与 platform/queue 里已有的两个逐字相同（kinds_test.go 有一条断言钉住）。
const (
	TypeNotifyReply    = "notify:reply"
	TypeNotifyMention  = "notify:mention"
	TypeNotifyLike     = "notify:like"
	TypeNotifyReward   = "notify:reward"
	TypeNotifyReview   = "notify:review"
	TypeNotifySanction = "notify:sanction"
)

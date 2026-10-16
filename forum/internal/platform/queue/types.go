// Package queue 的任务类型常量集中在本文件（拍板 §5.7「类型常量一处定义」；
// 取值与 notify.Kind* 的六个通知类别同名，notify/service_test.go 有一条断言钉住两边逐字一致）。
package queue

// 任务类型常量。payload 一律是最小形状，**不放业务快照**（快照会过期，拍板 §5.7）。
const (
	TypeMailSend = "mail:send" // {"id": <mail_log id>}

	// notify 的六个入队点（d4 §5.1 的 ①–⑥）。键与 notify.CreateNotifyInput 一一对应（d4 §1.1）：
	// {actor_id, ref_type, ref_id, topic_id, user_id}——ref_type 取值见 notify.Ref*，user_id 只有 mention 用。
	TypeNotifyReply    = "notify:reply"    // ref_type=post，ref_id=<post id>
	TypeNotifyMention  = "notify:mention"  // ref_type=post|comment，ref_id=<post id|comment id>，user_id=<被提及者>
	TypeNotifyLike     = "notify:like"     // ref_type=post|topic|comment，ref_id=<被赞对象 id>
	TypeNotifyReward   = "notify:reward"   // ref_type=donation，ref_id=<donation_record id>
	TypeNotifyReview   = "notify:review"   // ref_type=topic，ref_id=topic_id=<topic id>
	TypeNotifySanction = "notify:sanction" // ref_type=sanction，ref_id=<sanction id>

	TypeSearchIndex = "search:index" // {"id": <topic id>}
	// TypeAIReview 是 AI 审核（d7 §6）。payload 两种形状（app/tasks.go 的 reviewTopic 分派）：
	//   {"topic_id": <bigint>, "trigger": "create"|"report"|"edit"} —— 主题
	//   {"issue_id": <bigint>, "trigger": "report"}                —— Issue（0062_issue_archive）
	// edit 来自**编辑正文**：UpdateTopic 把改动存进待审槽后入队一条（forum/topics.go 的 UpdateTopic）。
	// issue_id 来自**举报到阈值**（report/reports.go → aireview.TriggerReportReview）——
	// 不新增任务类型：两种判定走同一条队列、同一套退避与优先级。
	TypeAIReview       = "ai:review"
	TypeImageGC        = "image:gc"        // {}
	TypeJobCleanup     = "queue:cleanup"   // {}
	TypeBackupSnapshot = "backup:snapshot" // {}
)

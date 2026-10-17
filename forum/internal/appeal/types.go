// Package appeal 是申诉与反馈域（C4 免登录申诉 + C5 帖子审核申诉）。
//
// 依据：完全重构/盲审合并结论.md §7（登录页让人「联系管理员」，但被封者登不进来、也发不了帖 ——
// 这条闭环是断的）、拍板 §10.10-1（POST /topics/{id}/review/appeal：登录 + 仅作者 + 幂等）、
// DevRoom 设计稿 web/src/devroom/pages/17-appeal/data.ts（四种事由、四种状态、成功态必须给单号）。
//
// 本域存在的理由只有一条：**被封的人登不进来**，所以「凭登录态自证」这条路对他不存在。
// 于是 POST /appeals 不收登录态，靠 用户名 + 注册邮箱 + 图形验证码 自证；
// 验得过就与那个账号绑定（identity_verified=true），验不过也**照收**（收下是本域存在的理由，
// 人判的时候看 identity_verified 那一列）—— 一律拒收等于把「账号被封了、但记不清当时填了哪个邮箱」
// 的人重新推回死路。
package appeal

// 事由值域：与 0022_appeals 的 ck_appeals_type 逐字一致，也是 DevRoom data.ts 的 APPEAL_TYPES 四个 key。
// 加一种事由 = 加一条常量 + 改 CHECK + 改 dto.go 的 binding tag，三处同名。
const (
	TypeBan          = "ban"           // 账号封禁申诉（免登录那条路的主角）
	TypeReviewReject = "review_reject" // 帖子审核被驳回（C5；只认作者本人）
	TypeReportResult = "report_result" // 举报处理结果有异议
	TypeOther        = "other"         // 其它反馈
)

// 状态三值（0022 的 ck_appeals_status）。
//
// 设计稿有第四态「已驳回」，这里**没有**：它与「已答复」的差别是判定内容，不是生命周期 ——
// 判完就是答复了，至于维持还是改判，看 decision 那一列。挤进同一个列以后，
// 「这条还开着吗」和「这条被驳回了」会互相覆盖，答不了「驳回之后还能不能补充材料」。
const (
	StatusPending = "pending" // 还没判
	StatusReplied = "replied" // 判了并答复了（没有关上，提交人还能补充材料）
	StatusClosed  = "closed"  // 判了、答复了、并且关掉了
)

// 判定值域（0022 的 ck_appeals_decision）：维持原处理 / 改判。NULL = 还没判。
const (
	DecisionUpheld     = "upheld"
	DecisionOverturned = "overturned"
)

// etaByType 是答复时限：**刻意放在后端**（DevRoom data.ts 的 done.eta 只是设计稿文案）。
// 前端拿它渲染「预计 3 个工作日内答复」；改 SLA 不该要求前端发版。
var etaByType = map[string]string{
	TypeBan:          "3 个工作日内",
	TypeReviewReject: "1 个工作日内",
	TypeReportResult: "3 个工作日内",
	TypeOther:        "5 个工作日内",
}

// ETA 返回某种事由的答复时限（值域外的 type 在校验层已经过不去）。
func ETA(appealType string) string { return etaByType[appealType] }

// 分页上限（与 report / notify 同一套：默认 20、上限 100，多取一条判到底）。
const (
	defaultLimit = 20
	maxLimit     = 100
)

// 免登录那条路的限流：**同一身份 24 小时最多 3 条**（DevRoom data.ts 的 MOCK_GUEST.errorNote
// 与 routes/appeal.tsx 的 429 文案写的都是这个数）——它是文案的契约，不是随手挑的数。
//
// 口径是**同 type + 同身份**（user_id，没绑上就按邮箱）：换一种事由是另一类额度。
// 这是刻意的（一次封禁事件里同一个人常常既要申诉又要反馈别的）；滥用那道闸门是
// 图形验证码 + 每类 3 条的组合，不靠把四类挤进一个额度。不引入第二张计数表：数 appeals 自己。
const (
	maxPerDay = 3
	dayWindow = 24
)

// noOffset 与 0022_appeals 生成列的表达式逐字一致（'AP-' || (id + 2000)）。
// 前缀在这边只出现在错误文案与测试里，真值由 DDL 生成。
const noOffset = 2000

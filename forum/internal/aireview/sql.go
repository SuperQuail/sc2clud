package aireview

// 本文件是本域的全部原生 SQL。集中写在一处：表结构（0020_ai_review）与语句的对应关系一眼能看全，
// 也不会出现「同一条语句在两个函数里各写一遍」。占位符一律 $n，绝不拼串。

// sqlSelectConfig 是 ai_config 单行表的读视图（**不含密钥明文，只回 has_secret**）。
const sqlSelectConfig = `
	SELECT enabled, provider, base_url, model, thinking, strict_mode, prompt, prompt_report,
	       temperature::float8, timeout_ms, max_output_tokens,
	       secret_cipher IS NOT NULL, secret_updated_at, last_ok_at, last_error, last_error_at
	  FROM ai_config WHERE id = 1`

// sqlSelectSecret 只在真正要外呼 / 要改密钥时用。
const sqlSelectSecret = `SELECT secret_cipher, secret_nonce FROM ai_config WHERE id = 1`

const sqlSaveSecret = `
	UPDATE ai_config SET secret_cipher = $1, secret_nonce = $2, secret_updated_at = now(),
	                     last_error = '', last_error_at = NULL, updated_at = now()
	 WHERE id = 1`

const sqlUpdateConfig = `
	UPDATE ai_config SET
	  enabled           = COALESCE($1, enabled),
	  provider          = COALESCE($2, provider),
	  base_url          = COALESCE($3, base_url),
	  model             = COALESCE($4, model),
	  thinking          = COALESCE($5, thinking),
	  strict_mode       = COALESCE($6, strict_mode),
	  prompt            = COALESCE($7, prompt),
	  prompt_report     = COALESCE($8, prompt_report),
	  temperature       = COALESCE($9, temperature),
	  timeout_ms        = COALESCE($10, timeout_ms),
	  max_output_tokens = COALESCE($11, max_output_tokens),
	  updated_at        = now()
	 WHERE id = 1`

const sqlMarkOK = `UPDATE ai_config SET last_ok_at = now(), last_error = '', last_error_at = NULL WHERE id = 1`

const sqlMarkError = `UPDATE ai_config SET last_error = $1, last_error_at = now() WHERE id = 1`

// sqlSubject 取一篇主题的全部判定输入：标题 + 1 楼正文（Markdown 源）+ 当前可见性与判定来源 + 未处理举报数
// + **图集里挂着的配图数**（topic_images 的引用行，与正文里的 ![] 是两件事）。
// **不含作者**：d7 §11 明确 prompt 里不放昵称/邮箱/IP。
// 真判定与审核屏的预览（preview.go）读同一条 —— 预览要是另起一条 SELECT，两边就会各自漂。
//
// $2 决定**判哪一版**，由调用点显式给（SQL 不自己挑）：
//   · true  = 待审槽那一份（rv.pending_md，没有待审改动时回落线上）—— 编辑触发判的就是这份改动；
//     管理端预览 / 试跑（Preview / TestTopic）也走 true：要显示「将要被审的那一版」，
//     与审核队列 draft 页签（pgsql/review_queue.go 的 reviewQueueColumns）同源。
//   · false = 线上那一份（p.content_md）—— create 与 report 判的都是读者看到的内容：
//     举报人举报的就是这一版，拿一份没人看得见的草稿去判，reject 会把线上帖 hidden 掉。
//
// 这条布尔是**调用点各给各的**，不是「哪种取值才正确」：曾经在这里无条件优先 pending_md
// （为与审核屏预览同源），副作用是 report 触发的复核也去审草稿 —— 判错了对象，
// 还罚了一个从没露过面的版本。
// 一帖一行的 uq_topic_revisions_topic 保证这个 JOIN 不会放大行数。
const sqlSubject = `
	SELECT t.id, t.public_id, t.title,
	       CASE WHEN $2 THEN COALESCE(rv.pending_md, p.content_md, '')
	            ELSE COALESCE(p.content_md, '') END,
	       t.visibility, t.review_source,
	       (SELECT count(*) FROM reports r
	         WHERE r.target_type = 'topic' AND r.target_id = t.id AND r.state = 'open'),
	       (SELECT count(*) FROM topic_images ti WHERE ti.topic_id = t.id)
	  FROM topics t
	  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
	  LEFT JOIN topic_revisions rv ON rv.topic_id = t.id
	 WHERE t.id = $1`

// sqlHasPending 问的是「这条帖有没有待审槽」：管理端预览 / 试跑要显示**将要被审的那一版**，
// 而「那一版」只在这条帖确实有待审改动时才存在（判据与 sqlSubject 的 $2=true 分支同一个）。
const sqlHasPending = `
	SELECT EXISTS (SELECT 1 FROM topic_revisions WHERE topic_id = $1 AND pending_md IS NOT NULL)`

// sqlTopicIDByPublicID 是对外 id → 内部 id 的换算：管理端手里只有 uuid（审核队列 DTO 的 id 就是它），
// 而判定链路（sqlSubject / topic_images）用自增 bigint 寻址。
const sqlTopicIDByPublicID = `SELECT id FROM topics WHERE public_id = $1`

// sqlTopicImages 取一篇主题的配图引用行，**按页面顺序**（楼层 → 该楼内的 sort，hash 兜底稳定序）。
// 顺带取 images 里登记的 mime/size：字节要不要读由 loadImages 按上限决定 ——
// 注定不发的那几张（超张数/超单张上限）不该白白读盘。
const sqlTopicImages = `
	SELECT ti.image_hash, ti.sort, COALESCE(p.floor, 0), i.mime, i.size
	  FROM topic_images ti
	  LEFT JOIN posts  p ON p.id = ti.post_id
	  LEFT JOIN images i ON i.hash = ti.image_hash
	 WHERE ti.topic_id = $1
	 ORDER BY COALESCE(p.floor, 0), ti.sort, ti.image_hash`

// sqlCallsToday 是「单帖当日 AI 调用次数」（d7 硬规则 3）：数 review_events 里 source='ai' 且今天的条数。
// 用 UTC 日期界：服务器时区不该让配额漂。
const sqlCallsToday = `
	SELECT count(*) FROM review_events
	 WHERE topic_id = $1 AND source = 'ai'
	   AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`

// image_count / image_skipped 是迁移 0053 加的两列（D33③）：判了几张、截了几张。
// 要能从记录本身读出来 —— 事后按 topic_images 重算会撒谎（作者可以事后加图删图）。
const sqlInsertEvent = `
	INSERT INTO review_events (topic_id, trigger, source, verdict, reason, categories, model, latency_ms,
	                           image_count, image_skipped)
	VALUES ($1, $2, 'ai', $3, $4, $5, $6, $7, $8, $9)`

// sqlUpdateTopic 只改该改的那几列：$2 为 NULL（verdict=review）时整段不动，
// 这样「AI 拿不准」不会把人工填的 review_note 覆盖掉。
// $4 为 true 时才动 visibility，且只到 hidden —— **AI 永远不写 deleted**（d7 硬规则 1）。
const sqlUpdateTopic = `
	UPDATE topics SET
	  review_state  = COALESCE($2, review_state),
	  review_note   = CASE WHEN $2 IS NULL THEN review_note ELSE $3 END,
	  reviewed_at   = CASE WHEN $2 IS NULL THEN reviewed_at ELSE now() END,
	  review_source = CASE WHEN $2 IS NULL THEN review_source ELSE 'ai' END,
	  visibility    = CASE WHEN $4 THEN 'hidden' ELSE visibility END,
	  updated_at    = now()
	 WHERE id = $1`

// ---- 编辑触发（trigger='edit'）的放行 ----
//
// **与 forum/pgsql/review_queue.go 的 PromotePendingRevision 是同一动作的两个实现**：
// 那边走 pgsql.Querier（database/sql 口味），这边是 pgx 原生的 pgx.Tx —— 两者接不到同一个
// 事务上（pgsql/store.go 的文件头写了为什么本域不用 pgxpool），跨包也共用不了这几条语句。
// **改一处必须改另一处**：后置条件逐条相同（posts 正文、topics.excerpt、快照 content_*、待审三列全空）。
// edit_trigger_test.go 的 TestEditPromoteMatchesManualPromote 把两边写出来的行逐列比成同形。

// sqlPendingContent 读待审槽的两份内容：md 给 posts 与快照，html 给摘要。
// 那边 pgsql 的实现由调用方把 md/html/excerpt 一起传进来；这边没人给渲染器，
// 摘要从**已有的 html** 提（用的就是 forum 装配渲染器时用的那个函数，见 platform/search 的 PlainText）。
const sqlPendingContent = `
	SELECT pending_md, pending_html FROM topic_revisions
	 WHERE topic_id = $1 AND pending_md IS NOT NULL`

// sqlMarkEditApproved 是「AI 对这份改动判了通过」的 topics 那一半。
// **不动 visibility**：它不是这次判定的对象 —— 因举报被 AI 隐藏过的帖子不该因为一次编辑
// 放行而被悄悄解开（那是另一次判定的事）。
const sqlMarkEditApproved = `
	UPDATE topics SET review_state = 'approved', review_note = $2, review_source = 'ai',
	                  reviewed_at = $3, updated_at = $3
	 WHERE id = $1`

// 下面三条 = PromotePendingRevision 去掉末尾那条 NOT EXISTS 的快照补插。
// 少了它不是偷懒：待审内容本身就住在 topic_revisions 那一行里，所以走这条路时行**必然已存在**，
// 那条补插永远不触发（人工那条路也一样，见 pgsql/review_queue.go 的 PromotePendingRevision）。
const sqlPromotePosts = `
	UPDATE posts SET content_md = $2, content_html = $3, updated_at = $4
	 WHERE topic_id = $1 AND floor = 1`

const sqlPromoteExcerpt = `UPDATE topics SET excerpt = $2, updated_at = $3 WHERE id = $1`

// approved_by = NULL：这次过审的是 AI，不是某个人 —— 那一列是「哪一次判定让它成为过审版本」
// 的指针，而 AI 判定没有 user id（人工那条路写的是 actor.UserID）。
const sqlPromoteRevision = `
	UPDATE topic_revisions
	   SET content_md = $2, content_html = $3, approved_by = NULL, approved_at = $4,
	       pending_md = NULL, pending_html = NULL, pending_at = NULL, updated_at = $4
	 WHERE topic_id = $1 AND pending_md IS NOT NULL`

const sqlInsertAudit = `
	INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at)
	VALUES (NULL, 'topic.ai_hide', 'topic', $1, $2::jsonb, now())`

// sqlMarkManual 是第二阈值（Human=true）的落点：标记为人工处理中，之后 AI 不再碰它。
// 条件写 review_source IS NULL：**绝不覆盖既有判定**（AI 的或人工的都不覆盖）。
const sqlMarkManual = `
	UPDATE topics SET review_source = 'manual', updated_at = now()
	 WHERE id = $1 AND review_source IS NULL`

// sqlCountReportRounds 给 unique_key 当轮次：同一轮的多次举报只触发一次复核（d7 §6）。
const sqlCountReportRounds = `SELECT count(*) FROM review_events WHERE topic_id = $1 AND trigger = 'report'`

// sqlListEvents 是「审核历史」（D63(b)）：review_events 倒序连主题与判定人一起取——审计屏一页的
// 全部展示列都在这条里，不为每个事件回头查一次主题（auth/audit.go 的 ListAuditSQL 同形状：
// 筛选全走参数，行比较游标 (created_at, id) < (k, id)，首页以 $3 IS NULL 短路）。
const sqlListEvents = `
	SELECT e.id, e.created_at, e.trigger, e.source, e.verdict, e.reason, e.categories, e.model,
	       e.latency_ms, e.image_count, e.image_skipped,
	       t.public_id, t.title,
	       u.public_id, u.username, COALESCE(NULLIF(u.nickname, ''), u.username)
	  FROM review_events e
	  JOIN topics t ON t.id = e.topic_id
	  LEFT JOIN users u ON u.id = e.actor_id
	 WHERE ($1::text        IS NULL OR e.verdict = $1)
	   AND ($2::text        IS NULL OR e.source  = $2)
	   AND ($3::timestamptz IS NULL OR (e.created_at, e.id) < ($3, $4))
	 ORDER BY e.created_at DESC, e.id DESC
	 LIMIT $5`

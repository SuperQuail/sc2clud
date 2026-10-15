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
const sqlSubject = `
	SELECT t.id, t.public_id, t.title, p.content_md, t.visibility, t.review_source,
	       (SELECT count(*) FROM reports r
	         WHERE r.target_type = 'topic' AND r.target_id = t.id AND r.state = 'open'),
	       (SELECT count(*) FROM topic_images ti WHERE ti.topic_id = t.id)
	  FROM topics t
	  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
	 WHERE t.id = $1`

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

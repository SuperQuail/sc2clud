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

// sqlSubject 取一篇主题的全部判定输入：标题 + 1 楼正文（Markdown 源）+ 当前可见性与判定来源 + 未处理举报数。
// **不含作者**：d7 §11 明确 prompt 里不放昵称/邮箱/IP。
const sqlSubject = `
	SELECT t.id, t.public_id, t.title, p.content_md, t.visibility, t.review_source,
	       (SELECT count(*) FROM reports r
	         WHERE r.target_type = 'topic' AND r.target_id = t.id AND r.state = 'open')
	  FROM topics t
	  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
	 WHERE t.id = $1`

// sqlCallsToday 是「单帖当日 AI 调用次数」（d7 硬规则 3）：数 review_events 里 source='ai' 且今天的条数。
// 用 UTC 日期界：服务器时区不该让配额漂。
const sqlCallsToday = `
	SELECT count(*) FROM review_events
	 WHERE topic_id = $1 AND source = 'ai'
	   AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`

const sqlInsertEvent = `
	INSERT INTO review_events (topic_id, trigger, source, verdict, reason, categories, model, latency_ms)
	VALUES ($1, $2, 'ai', $3, $4, $5, $6, $7)`

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

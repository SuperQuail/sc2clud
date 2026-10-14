# D7 AI 帖子审核（上线刚需）

> 用户 2026-10-12 定案：**必须做，国内模型，默认供应商 DeepSeek，用 deepseek 的 flash 模型，替代人工帖子审核**；**被多次举报就复审，再审不过就转人工**。
> 本文取代 论坛后端技术方案-v2.md §20.3 里「AI 内容审核 —— 明确不做」那一条。
> **模型与调用形状已照 DeepSeek 官方文档核实**（2026-10-12 读 api-docs.deepseek.com 中文站）：
> 模型名 = deepseek-flash（DeepSeek-V4.1-Flash，1M 上下文 / 384K 输出，支持 Tool Calls 与 Json Output，并发 2500）；
> base_url = https://api.deepseek.com；空闲时段价格（百万 tokens）：输入命中缓存 0.02 元、输入未命中 1 元、输出 4 元。

## 0. 一句话

**AI 是第一道审核（默认），人是最后一道。** 新帖先给 AI 判一次；被举报到阈值再用同一套提示词复审一次；AI 说拿不准、或复审仍不过、或调用失败 → 转人工。
除这三处，审核链路与人工版完全一样（review_state / review_note / reviewed_*），所以它**不是独立业务线，而是审核队列的一个判定来源**。

## 1. 状态机（终局）

    用户发主题
     ├─ users.trusted 或持 post.review  → approved（免审，review_source='trusted'，不调 AI）
     └─ 否则                             → EnqueueTx(ai:review) → pending（对作者与审核者可见）

    ai:review 任务（队列里跑，绝不进发帖事务）
     ├─ AI 判通过    → review_state=approved, source='ai'
     ├─ AI 判违规    → review_state=rejected, review_note=AI 给的中文理由, source='ai'
     ├─ AI 判拿不准  → 留在 pending, source='ai'，进人工队列
     └─ 调用失败/超时/没配密钥 → 留在 pending, source=NULL，进人工队列（**绝不阻塞发帖**）

    举报累计到阈值 1（默认 3）→ EnqueueTx(ai:review, trigger='report')
     └─ 复审：同一提示词 + 一句「该帖已被 N 人举报，重点看是否违规」
          ├─ 复审判违规 → visibility='hidden'（**不是 deleted**，可恢复）+ source='ai' + 写审计
          ├─ 复审判通过 → 不改可见性，把这一轮举报标记为已处理（避免同批举报反复触发）
          └─ 拿不准/失败 → 转人工（举报保持 open）
    举报累计到阈值 2（默认 5）→ **直接转人工，不再调 AI**（防举报风暴打爆额度）

三条硬规则：
1. **AI 不删内容**：它最多把 visibility 置 hidden（可恢复）；deleted 只有人能按。
2. **AI 失败不影响发帖**：任务退避重试 2 次后放弃，留在 pending 交人工，记 last_error。
3. **同一篇主题的 AI 调用有上限**（默认 3 次/主题/天）。

## 2. 配置与密钥

### 2.1 新表 ai_config（单行表，恒为 id=1）

    CREATE TABLE ai_config (
      id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled        boolean      NOT NULL DEFAULT true,
      provider       text         NOT NULL DEFAULT 'deepseek'
                     CONSTRAINT ck_ai_config_provider CHECK (provider IN ('deepseek','openai_compatible')),
      base_url       text         NOT NULL DEFAULT 'https://api.deepseek.com',
      model          text         NOT NULL DEFAULT 'deepseek-flash',
      thinking       boolean      NOT NULL DEFAULT false,   -- **可选**：false=快（Tool Calls 路径）／true=推理（JSON 路径），见 §3.4
      prompt         text         NOT NULL DEFAULT '',      -- 留空用内置默认提示词（§4）
      timeout_ms     int          NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
      max_output_tokens int       NOT NULL DEFAULT 512 CHECK (max_output_tokens BETWEEN 64 AND 4096),
      strict_mode    boolean      NOT NULL DEFAULT false,   -- true 时走 /beta 的 strict（§3.3）
      secret_cipher  bytea        NULL,      -- API Key 密文（chacha20poly1305），**永不回显**
      secret_nonce   bytea        NULL,
      secret_updated_at ts        NULL,
      last_ok_at     ts           NULL,
      last_error     text         NOT NULL DEFAULT '',
      last_error_at  ts           NULL,
      created_at     ts           NOT NULL DEFAULT now(),
      updated_at     ts           NOT NULL DEFAULT now()
    );

- **密钥加密与发信凭据完全同一套**（chacha20poly1305 + FORUM_SECRET_MAIL_KEY）：同一类东西用同一套机制，不为它多引入一把主密钥与一套轮换流程。
- provider 只两个值：deepseek（默认）与 openai_compatible（任何兼容 OpenAI /chat/completions 的服务，含自建）。**不做每家一个 adapter**——协议相同就没有第二份实现。

### 2.2 阈值进 site_settings（管理员可改，不发版）

| key | 默认 | 含义 |
|---|---|---|
| ai.review.enabled | true | 总开关（与 ai_config.enabled 是「且」） |
| ai.review.report_threshold_1 | 3 | 未处理举报到这么多 → AI 复审 |
| ai.review.report_threshold_2 | 5 | 到这么多 → 直接转人工，不再调 AI |
| ai.review.daily_limit_per_topic | 3 | 单帖每日 AI 调用上限 |

### 2.3 模型：默认 deepseek-flash

**用户说的「flash 模型」就是官方模型名 deepseek-flash**（DeepSeek-V4.1-Flash）：1M 上下文、384K 输出、支持 Tool Calls 与 Json Output，**并发 2500**——比 deepseek-v4-pro（并发 500）宽得多，价格也低一档。
审核是分类任务而非推理任务，要的是快与便宜，所以默认它；模型名是配置项，以后出新版改一个值即可。

**旧名字不要用**：官方文档明确说 deepseek-chat / deepseek-v4-flash 这些名字对应的模型**已下线**（请求会被 Flash 接管并按 Flash 计费）。所以默认值必须是 deepseek-flash。

### 2.4 请求大小与成本：**不做截断**

**不做任何截断。** 正文在写入口就有一万字上限，约等于 4000 tokens；而 deepseek-flash 是 1M 上下文。
截断会让 AI 只看到半篇帖子，**判出来的结论就是错的**——那是「为了省钱把功能做坏」，属于明令禁止的防御性代码。

| 措施 | 值 | 说明 |
|---|---|---|
| 输出上限 | max_output_tokens = 512 | schema 只有三个字段；输出 token 上限与输入大小无关 |
| 单帖频次 | 3 次/天（§2.2） | 只对**真实的浪费**（同一帖被反复触发）设限 |
| 超时 | 20s | 超时转人工，不无限重试 |

按一万字正文算，**一次审核约 0.4 分钱**，一天 100 篇 ≈ 0.4 元。
**只对真实浪费设上限，不对「文章本来就长」设上限。**
## 3. 调用形状（**用 Tool Calls，不用 JSON Output**）

### 3.1 为什么用工具调用而不是 JSON Output

官方 JSON Output 文档自己写着两条注意：① prompt 里必须含 json 字样并给样例；② **「有概率返回空的 content」**。
Tool Calls 把「结构化输出」交给服务端约束，我们直接读 `tool_calls[0].function.arguments`（一个 JSON 字符串），**不需要在自由文本里挖 JSON**。
所以：**主路径用 Tool Calls + tool_choice=required**（强制必须调用），JSON Output 只作为 `openai_compatible` 兼容模式的退路。

### 3.2 请求

    POST {base_url}/chat/completions
    Authorization: Bearer <解出来的 api_key>
    Content-Type: application/json

    {
      "model": "deepseek-flash",
      "messages": [
        { "role": "system", "content": "<§4 的提示词>" },
        { "role": "user",   "content": "标题：…\n\n正文：…" }
      ],
      "tools": [ {
        "type": "function",
        "function": {
          "name": "submit_review",
          "strict": <ai_config.strict_mode>,
          "description": "提交这篇帖子的审核结论",
          "parameters": {
            "type": "object",
            "properties": {
              "verdict": { "type": "string", "enum": ["approve","reject","review"],
                           "description": "通过 / 违规 / 拿不准交人工" },
              "reason":  { "type": "string", "description": "给用户看的中文理由，不超过 60 字" },
              "categories": { "type": "array", "items": {
                                "type": "string",
                                "enum": ["spam","ad","abuse","off_topic","illegal","other"] } }
            },
            "required": ["verdict","reason"],
            "additionalProperties": false
          }
        }
      } ],
      "tool_choice": "required",
      "temperature": 0,
      "max_tokens": 256,
      "stream": false,
      "user_id": "review"
    }

**参数纪律**（都来自官方文档，不是猜的）：

| 参数 | 取值 | 为什么 |
|---|---|---|
| tool_choice | `"required"` | 强制必须调用工具（官方支持）；**思考模式下不支持 required**，所以 thinking 必须为 false（§3.4） |
| temperature | `0` | 分类任务要确定性；审核结论不该抖 |
| max_tokens | `256` | schema 只有三个字段，多了是浪费 |
| frequency_penalty / presence_penalty | **不传** | 官方已标注 deprecated，传了没效果 |
| user_id | `"review"` | 建议填（用于内容安全与缓存隔离）；**绝不填用户隐私信息** |
| stream | `false` | 审核要的是结论，不是打字机效果 |

### 3.3 strict 模式（可选，默认关）

官方：strict 模式**要求 base_url 用 `https://api.deepseek.com/beta`**，且所有 function 都要 `strict: true`，服务端会校验我们的 JSON Schema。
开了它，「模型不按 schema 输出」的概率降到接近零。**代价是走 beta 域名**（可用性承诺与正式域名不同）。
所以默认 `strict_mode = false`，把「解析失败」当成正常路径处理（§3.5）；想更稳就打开它。

### 3.4 思考模式：**可选**（ai_config.thinking）

用户定案：**推理模式是可选开关，不是写死的**。默认关（快），需要时打开。
两种模式走**两条不同的结构化输出路径**——因为官方明确「**思考模式下不支持 tool_choice: required**」：

| thinking | 结构化输出 | 怎么取 |
|---|---|---|
| false（默认） | **Tool Calls**，tool_choice = "required"（强制必须调用） | 读 tool_calls[0].function.arguments |
| true | **JSON Output**，response_format = {"type":"json_object"} | 读 choices[0].message.content；**提示词末尾必须补「以 JSON 输出」并给样例**（官方要求） |

两条路径**共用同一套解析与判定**（§3.5 的 JSON 解析、verdict 三值、失败转人工），只有「从响应里取哪一段 JSON」不同。
**不要为思考模式写第二套业务判断**——那会变成两份真源。

什么时候打开：AI 转人工比例偏高、或复审出现误判，说明简单分类不够用时。打开会更慢（多一段推理）也更贵（推理 token 计入输出）。

### 3.5 响应解析（**这是整个模块最需要写对的一段**）

    thinking = false：resp.choices[0].message.tool_calls[0].function.arguments  → 一个 JSON 字符串
    thinking = true ：resp.choices[0].message.content                         → 一段 JSON 文本

按顺序判：

1. `choices` 为空 / `tool_calls` 为空 → **fail-open 到人工**（`review`），记 `last_error`，任务成功返回（不重试，重试也是同样结果）；
2. `arguments` 不是合法 JSON → 同上；
3. `verdict` 不在三值内 → 同上；
4. `reason` 缺失或为空 → **不等于失败**：用一句兜底中文（「审核未给出理由」），verdict 照用；
5. `reason` 超 200 字符 → 截断；
6. `finish_reason == "length"` → 输出被截断（说明 max_output_tokens 给小了），**当作拿不准转人工**；
7. `finish_reason == "content_filter"` → **当作违规**（服务端自己都触发了过滤策略），`review_note` 写「内容触发了服务端过滤」。

**绝不猜、绝不放行**：任何解析不出来的情况，落到「转人工」这一档。

### 3.6 错误处理与重试

| 情况 | 动作 |
|---|---|
| HTTP 401 / 403 | **不重试**，记 `last_error`（密钥错），任务 dead，界面提示去配密钥 |
| HTTP 429 | 尊重 `Retry-After`，退避重试（算一次重试） |
| HTTP 5xx / 网络错误 / 超时 | 退避重试 |
| 余额不足（402 之类） | 不重试，dead，界面提示 |
| 重试耗尽（max_retry=2） | 留在 pending 交人工 |
## 4. 提示词（内置默认，可被 ai_config.prompt 覆盖）

    你是中文社区（星际争霸战役作者社区）的内容审核员。判断下面这篇帖子是否适合公开发布。

    拒绝（reject）—— 只在这些情况：
      · 广告、推广、拉群、卖号、引流到站外交易；
      · 辱骂、人身攻击、地域/民族歧视、色情、暴力威胁；
      · 违法违规内容；
      · 与本站主题完全无关的刷屏内容。

    拿不准（review）—— 下列情况必须交人工，不要自己决定：
      · 你不确定是否违规；
      · 内容涉及争议话题、指控某个人、或涉及真实身份；
      · 正文为空、噪声、或明显是机器生成的乱码；
      · 任何你无法判断的情境。

    其余一律通过（approve）。**宁可放过，不可错杀**——本站是创作者社区，误杀一篇正常帖子的代价远大于放过一篇边缘内容。

    理由（reason）用中文，不超过 60 字，直接说原因，不要复述规则。
    调用 submit_review 提交结论。

**为什么「宁可放过」写得这么重**：这是分类任务里唯一不可逆的错误方向——误杀会让作者直接流失，而且他不一定会申诉。

**注意**：这条提示词里没有 json 字样。用 Tool Calls 时不需要（那是 JSON Output 的要求）；
但 `openai_compatible` 兼容模式退回 JSON Output 时，**必须在提示词末尾补一句「以 JSON 格式输出」并给样例**，否则服务端不会保证 JSON。

## 5. 表结构改动

### 5.1 topics 加一列

    ALTER TABLE topics ADD COLUMN review_source text NULL
      CONSTRAINT ck_topics_review_source CHECK (review_source IN ('ai','manual','trusted'));

### 5.2 新表 review_events（审核留痕，只增不改）

审核会被触发多次（首次 + 每次举报复审）；**只留最后一列会丢掉「AI 先说通过、后来复审说违规」这种事实**，而那正是申诉时要看的东西。

    CREATE TABLE review_events (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      topic_id    bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      trigger     text   NOT NULL,   -- 'create' | 'report' | 'manual'
      source      text   NOT NULL,   -- 'ai' | 'manual' | 'trusted'
      verdict     text   NOT NULL,   -- 'approve' | 'reject' | 'review'
      reason      varchar(200) NOT NULL DEFAULT '',
      categories  text[] NOT NULL DEFAULT '{}',
      model       varchar(64) NOT NULL DEFAULT '',   -- 实际用的模型名；人工为空
      latency_ms  int    NOT NULL DEFAULT 0,
      actor_id    bigint NULL,        -- 人工审核时的管理员；AI 为空
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_review_events_source  CHECK (source  IN ('ai','manual','trusted')),
      CONSTRAINT ck_review_events_verdict CHECK (verdict IN ('approve','reject','review')),
      CONSTRAINT ck_review_events_trigger CHECK (trigger IN ('create','report','manual'))
    );
    CREATE INDEX idx_review_events_topic ON review_events (topic_id, created_at DESC, id DESC);
    CREATE INDEX idx_review_events_ai    ON review_events (source, created_at DESC) WHERE source = 'ai' AND verdict = 'review';

**为什么是新表而不是 topics 上几列**：审核是**一串事件**，不是当前状态。当前状态已在 review_state / review_note / reviewed_*；
review_events 只回答「它被谁、因为什么、判过几次」。
这也是「不做 post_revisions」那条（拍板 §6）的分界：**我们不存内容的历史，只存判定的事件**。

## 6. 队列任务

    TypeAIReview = "ai:review"     // payload { "topic_id": <bigint>, "trigger": "create"|"report" }

| 项 | 值 | 为什么 |
|---|---|---|
| unique_key | create: `review:create:<topic_id>`；举报复审: `review:report:<topic_id>:<轮次>`（轮次 = 已发生的 report 类事件数） | 同一轮的多次举报只触发一次复审 |
| priority | 20 | 快于通知（0）、不与验证码邮件（10）抢？——**20 高于 10**，所以审核比验证码更优先。这是有意的：验证码可以晚几秒，审核晚几秒用户就在看「审核中」 |
| max_retry | 2 | 比默认 5 少：重试太久没意义，第 3 次直接交人工 |
| 幂等 | 进入时先查 review_source；若为 'manual' → 直接返回 nil | **AI 绝不覆盖人工判定** |

任务处理顺序（照 §1 状态机）：

    1. 读 ai_config 与 site_settings（阈值、开关）；任一关闭 → 记 Debug 并返回 nil
    2. 取主题：title + 1 楼 PlainText(content_html)；主题已删除/已人工审 → 返回 nil
    3. 判单帖当日调用次数（review_events 里 source='ai' 且今日的条数）超限 → 返回 nil（转人工由状态机保证：它还留在 pending）
    4. 组装 prompt（§4）与 user 消息（标题 + 正文；**不截断**，见 §2.4 与 §8）
    5. 调 DeepSeek（§3），记 latency_ms
    6. 解析（§3.5）→ 得 verdict / reason / categories
    7. 单事务：写 review_events + 改 topics.review_state / review_note / reviewed_at / review_source
       （reject 时同时写审计；复审 reject 时额外把 visibility 置 hidden）
    8. 返回 nil（重放幂等：verdict 相同、事件多一条也可接受；用 unique_key 已把「同一轮重复触发」挡掉了）

## 7. 举报 → 复审的计数（一条 SQL）

    -- 该主题当前未处理的举报数
    SELECT count(*) FROM reports
     WHERE target_type = 'topic' AND target_id = $1 AND state = 'open';

`uq_reports_once` 是 (reporter,target) 的部分唯一索引，帮不上这个计数；`idx_reports_queue (state, created_at DESC)` 也帮不上。
**所以要补一条按目标的索引**（reports 由 D6 建，这条记给 D6）：

    CREATE INDEX idx_reports_target_open ON reports (target_type, target_id) WHERE state = 'open';

举报写入后（**同一事务**）判阈值并 `EnqueueTx(ai:review)`；判定用的就是上面那句 count —— 走新索引，代价 O(该目标的未处理举报数)。
## 8. 管理端

| 位置 | 内容 |
|---|---|
| 站点设置 → AI 审核 | 开关、provider、base_url、model（默认 deepseek-flash）、思考模式、超时、正文截断、输入 token 上限、strict、提示词（多行）、**API Key（只写不回显）** |
| 同上 | 「测试连通」按钮 → `POST /api/v1/admin/ai/test`：调一次真实接口（用一段固定短文本，不消耗用户内容），返回耗时、实际模型名、原始 verdict |
| 同上 | 用量与失败率（24h / 7d）：调用数、通过/拒绝/转人工占比、平均耗时、失败数——来自 review_events 与 ai_config.last_error |
| 帖子审核队列 | 每条显示**判定来源**（AI / 人工 / 免审）与最近一次理由；**AI 转人工的高亮** |
| 帖子详情（管理视角） | 判定时间线（review_events 倒序）：谁判的、什么理由、耗时、触发方式 |

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET/PATCH | /api/v1/admin/ai/config | site.setting |
| POST | /api/v1/admin/ai/config/secret | site.setting（单独端点写密钥） |
| POST | /api/v1/admin/ai/test | site.setting |
| GET | /api/v1/admin/ai/stats | site.setting |

**密钥永不回显**：GET 只返回 has_secret 与 secret_updated_at；PATCH 里没有密钥字段。
**不新造权限点**（沿用 site.setting）。

## 9. 与既有设计的关系（改动清单）

| 文档 | 改动 |
|---|---|
| v2 §20.3 | 删掉「AI 内容审核 —— 明确不做」那一行 |
| v2 §13.2 | 补：AI 凭据与发信凭据同一套加密与主密钥 |
| v2 §21.2 | 补 §8 的四个 admin 端点 |
| v2 §7.4 | 补 TypeAIReview = "ai:review" |
| 拍板 §6 | 删掉与 AI 审核相关的「人工举报先顶上」表述 |
| D3 | topics 加 review_source；新帖 review_state 走 §1 状态机（不再直接 approved） |
| D6 | reports 加 idx_reports_target_open；举报写入后判阈值 + EnqueueTx |
| D2 | 无改动（AI 配置不碰认证域） |
| 管理后台（15-admin） | AI 配置屏 + 队列判定来源与理由 + 详情判定时间线 |
| 帖子页（12-topic） | 三种审核态的界面表达（拍板 §10.4） |

## 10. 验收（必须能红）

1. **没配 API Key** → 发帖照常成功，主题留 pending，人工队列里能看到（**AI 挂了不能挡发帖**）；
2. 配好 Key → 发一篇正常帖 → 自动 approved，review_source='ai'，review_events 有一条 trigger='create'；
3. 发一篇明显广告 → 自动 rejected，review_note 是中文理由，作者看得到；
4. **模型返回空 tool_calls**（用假服务端模拟）→ 判为转人工，**绝不自动通过**；
5. 模型返回非法 JSON / verdict 越界 → 同上；
6. 一篇帖被 3 个不同用户举报 → 触发**一次** ai:review（trigger='report'），同轮重复举报不叠加（断言 jobs 里只有一条）；
7. 复审判违规 → visibility='hidden' + 写审计；判通过 → 可见性不变且该轮举报被标记处理；
8. 累计到 5 条举报 → **不再调 AI**（断言 HTTP 调用次数没增加），直接进人工队列；
9. 人工审过的帖子，AI 任务重放**不覆盖**（review_source='manual' 时任务直接返回）；
10. 单帖一天触发 3 次后第 4 次不再调 AI；
11. `/admin/ai/test` 用错 Key → 界面显示 401，且**响应里不含密钥**；
12. GET /admin/ai/config 的响应 JSON 里**不含任何密钥字段**（断言字符串里没有 api_key / secret）；
13. finish_reason='length' → 转人工；finish_reason='content_filter' → 判违规；
14. 输入 6000 字以上的正文 → 请求体里正文被截断，且**请求 token 估算不超过 max_input_tokens**。

## 11. 明确不做

| 不做 | 理由 |
|---|---|
| 送图片给模型 | 虽然 deepseek-flash 支持图像理解，但本站图片是用户内容，送第三方是额外隐私暴露；等真有需求再单独评估 |
| 预审草稿（发之前先判） | 会让发帖多一次外部依赖的等待；先发后审 + 不可见更稳 |
| 多家 provider 各写 adapter | 协议兼容就只留一个 openai_compatible |
| 让 AI 直接 deleted | 不可逆；AI 最多到 hidden，删除永远是人 |
| 用 AI 判举报真假 | 举报是人的行为，不是内容，不混 |
| prompt 里放作者信息 | 昵称/邮箱/IP 与审核无关，且是隐私 |
| 用 deepseek-v4-pro | 审核不需要推理链，而它贵一档、并发只有 500 |
| 流式输出 | 审核要的是结论，不是打字机效果 |
## 8. 实现偏差（2026-10-14，Lead 记账）

实现这一轮时发现**当前依赖 `sashabaranov/go-openai` 有两条硬限制**，两条都直接影响 §3.2 的参数纪律：

| # | d7 要求 | 依赖的限制 | 当前实现 |
|---|---|---|---|
| 1 | `tool_choice: "required"` 强制调用；关掉思考（思考模式下不支持 required） | 关思考要发厂商扩展字段 `thinking`，只能走 `extra_body`；**该 SDK 不支持 extra body** | 发 `tools` 但**不强制**（思考模式下官方支持工具调用）；模型没调工具按 §3.5 fail-open 到人工 |
| 2 | `temperature: 0`（分类任务要确定性） | 字段是 `float32` + `omitempty`，**传 0 会被丢弃** → 实际用的是模型默认值（1.0） | 暂时接受，**判定会抖**；已记 TODO |

**修法（唯一正确的那个）**：换成官方 `openai/openai-go` —— 它用 `param.Opt` 显式表达「传了 0」，
并且支持 `ExtraFields`（可发 `thinking`）。**不手写 HTTP 去绕**：那等于自己维护一个更差的 SDK，
与「宁可引依赖也不自己写糟糕实现」这条规矩相反。

### 另外一处文档自相矛盾（已按明确条款执行）

§6 第 4 步写「组装 user 消息（标题 + 正文，**按 §2.4 截断**）」，而 §2.4 自己写着「**不做任何截断**」。
两处冲突时按**明确禁止的那条**执行：**不截断**（截断会让 AI 只看到半篇，判出来的结论就是错的）。
已把 §6 那句改掉。
### 第三条偏差（换官方 SDK 之后仍然存在，2026-10-14）

换成官方 `openai/openai-go` 后，前两条偏差已经**修好并有用例证明**：

| 偏差 | 现状 | 证据 |
|---|---|---|
| `temperature: 0` 发不出去 | **已修** | 用例断言请求体里有 `"temperature":0`（`param.NewOpt(0.0)` 能把 0 显式发出去） |
| 关掉思考 | **已修** | 用例断言请求体里有 `"thinking":{"type":"disabled"}`（`SetExtraFields` 透传未知字段） |
| `tool_choice: "required"` | **仍未发出** ✗ | 上游 SDK v1.12.0 的 `ChatCompletionToolChoiceOptionUnionParam` **序列化不出来**：
具名构造器与 `OfAuto` 都赋值成功但请求体里没有该字段；`SetExtraFields` 又会把**已知字段**过滤掉（`thinking` 能过、`tool_choice` 过不去）。 |

**影响与兜底**：不发 `tool_choice` 时模型仍会调用 `submit_review`（我们的 schema 只给这一个工具），
万一没调，`§3.5` 的 fail-open 会让它转人工 ✓ —— **不会因此放行违规内容**。
**修法**：等上游修联合序列化（或换 OpenAI 官方的 Go SDK 大版本）后，把它挪回 `ToolChoice` 字段；
代码里那条注释写明了这件事，用例里也标了「上游修好就加回断言」。
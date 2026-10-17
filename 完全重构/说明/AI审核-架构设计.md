# AI 审核 · 架构设计（2026-10-14，写代码之前）

> 前提：**老站的实现是「需求与行为的参考」，不是代码参考**（用户明确：老站代码质量很差，不允许照搬）。
> 这篇先定分层、真源、失败策略与扩展点，再动手。

## 一、先记住：从老站拿什么、不拿什么

| 拿（需求/行为） | 不拿（实现） |
|---|---|
| 判定是**三态**（通过/待定/不通过），不是 bool | 把三态硬编码成三个字符串分支散在各处 |
| 判据写在**工具描述**里，提示词只说社区规则 | 把提示词默认值硬编码进迁移 SQL |
| 每次审核**留痕**（发了什么、回了什么、判了什么） | `ai_reviews` 用 `target_kind` 字符串 + 无外键的弱约束 |
| **预览要发的文本 + 立刻审一次**（试跑） | 试跑与自动审核走两条几乎一样的实现 |
| 失败**重试一次**再记失败 | 失败只写一张表、没有队列语义 |
| 「审过没」是个布尔意义的状态，**复审由内容变更触发** | 用时间戳 + 冷却窗口表达「审过」（老站没这么写，是我上一版的歪路） |
| API key 可后台配置 | **明文存库**（老站注释写「单机自建站可接受」——不接受） |

## 二、分层（Go 侧）

```
platform/ai/            只懂协议：OpenAI 兼容的 chat + tool calls。不懂论坛、不懂数据库。
  Client 接口 + deepseek 实现（用 openai SDK）+ 假实现（测试用）
  Review(ctx, Request) (Result, error)   Request{Model,Prompt,Text,Tools,MaxTokens,Timeout}

forum/                  审核的**判定与状态机**（领域）：
  review_ai.go           Verdict(approve/pending/reject) · ToolName/FromToolName · ReviewState
                         PostReviewText/CommentReviewText（要发出去的东西，后台可预览）
  review_service.go      ReviewTopic(ctx, kind, id, source) —— 取文本 → 调 AI → 落状态 → 留痕（一个事务）
                         ReviewPending(ctx, limit) —— 扫队列，逐条调前者

app/                    只做装配与触发：构造 platform/ai 的实现并注入 forum；cron 里按间隔调 ReviewPending。
```

**为什么这么分**：现在我把 SDK 调用、SQL、状态机全塞在 `app/ai_review.go` 里 —— `app` 是「唯一认识所有域的地方」，
它该做的是**装配**，不是业务。审核是论坛领域的事（它改的是 topics 的状态），所以判定与编排都回 `forum`；
协议细节（OpenAI 兼容、tool call 解析）下沉到 `platform/ai`（与 `platform/search`、`platform/mail` 同一层，同一个理由）。

## 三、配置的**唯一真源**

| 项 | 放哪 | 为什么 |
|---|---|---|
| `enabled` / `endpoint` / `model` / `max_tokens` / 两段提示词 | **`site_settings`（后台可改）** | 编辑器要能改；改完**下一次审核即生效**，不需要重启 |
| **API key** | **env（`FORUM_AI__KEY`）** | 它是运维凭据，不进数据库、不进后台页面、不进日志 |
| 队列间隔 / 批量 / 超时 | config（运维调） | 影响资源占用，属于部署参数，不属于运营参数 |

**config 里的 `AI.Endpoint/Model/Prompt*` 只作为 `site_settings` 缺失时的默认值** ——
读取路径统一走一个 `Settings` 快照（每轮审核取一次），不散落 `cfg.AI.X` 到各处。

这一条直接修掉我上一版的两个问题：① 提示词在 env 里 → 编辑器改不了；② 两处都有 → 两份真源。

## 四、数据模型（对老站的改进）

```sql
-- topics：审过没
ai_reviewed boolean NOT NULL DEFAULT false

-- 留痕：不照老站的松耦合字符串，收紧一点
ai_reviews (
  id bigint identity primary key,
  kind        text NOT NULL CHECK (kind IN ('topic','comment','report')),
  target_id   bigint NOT NULL,                    -- 内部 id；不跨表外键（三张目标表），由写入方保证
  source      text NOT NULL CHECK (source IN ('new_post','edit','manual','report')),
  verdict     text NOT NULL CHECK (verdict IN ('approve','pending','reject','error')),
  reason      text NOT NULL DEFAULT '',
  raw_response text NOT NULL DEFAULT '',          -- 模型原话（截断留痕）
  model       text NOT NULL DEFAULT '',
  prompt_sha  text NOT NULL DEFAULT '',            -- 提示词指纹：改了提示词之后能分辨「这条是哪版判的」
  ok          boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
)
```

**加的 `prompt_sha` 是有原因的一条**：留痕的价值在于事后能复现判断依据；只记模型不记提示词，
改了提示词之后就说不清「当时是按哪套规则判的」。

## 五、失败与成本策略（写清楚，别散在代码里）

| 情况 | 行为 |
|---|---|
| 单条外呼失败 | **重试一次**；仍失败 → 留痕 `verdict=error, ok=false`，**保留在队列**（下轮再来） |
| 401（key 错）/ 402（欠费） | **当场中止本轮**：剩下的条目必然同样失败，重试只是把同一个错刷 N 遍 |
| 429 / 5xx | 算普通失败：本轮跳过，下轮再来（不在这里做退避，间隔本身就是退避） |
| `finish_reason=length` | 当失败（文档明写会截断）——截断的判定不能当结论用 |
| 模型没调工具 / 调了不认识的工具 | 当失败（不能默认通过） |
| 成本 | 每条帖子**只审一次**（bool 保证）；批量可配；提示词与工具定义固定 → 命中上下文缓存 |

## 六、扩展点（新增一类审核对象时改哪里）

新增「评论审核」只应改动四处，**不复制编排**：
1. `site_settings` 加一段提示词；2. `forum` 加一个 `CommentReviewText`（已有骨架）；
3. 队列 SQL 换成评论表；4. `ai_reviews.kind` 加一个取值（CHECK 一起改）。

**不做**「为了以后可能有多种目标」的提前抽象（不需要 provider 注册表、不需要插件接口）——
真加第二类时按上面四处改，比提前抽象一层更好读。

## 七、这一轮要做的（后端完整可用）

1. `platform/ai`：Client 接口 + SDK 实现 + 假实现；
2. `forum`：判定/工具/文本化（已有，收进来）+ `ReviewTopic` / `ReviewPending`（含重试与熔断）；
3. `site_settings` 的读写（后台可改）+ `Settings` 快照；
4. **试跑端点**（预览文本 + 立刻审一次，返回判词/理由/模型/耗时/原始返回）；
5. 留痕查询端点（按 target 过滤，编辑器要用来显示历史）；
6. `app`：装配 + cron 触发；删掉现在塞在 `app/ai_review.go` 的业务代码；
7. 用例：判定映射、文本形状、没 key 不外呼、请求带 tools、截断当失败、不认识的工具当失败、
   **失败重试一次**、**401 中止本轮**、**设置改了下一轮即生效**。

写完之后**再做一次代码质量评估**（用户要求），届时按「真实负载 / 可扩展 / 可维护」三条重新过一遍。
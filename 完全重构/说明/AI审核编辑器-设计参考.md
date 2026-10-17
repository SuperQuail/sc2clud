# AI 审核编辑器 · 设计参考（2026-10-14）

> 用户要求：**先拉 open-webui 读它的做法，再参考老站已有的实现**，然后在 **devroom 里做出来并验收**，通过后才整合。
> 这份文档是那两件参考的结论 —— 给做 devroom 那一屏的人用。

## 一、老站已经有这件东西（不是从零设计）

`site/crates/sc2clud-web/src/admin_ai.rs` + `site/migrations/0029_ai_review.sql`：

| 设置项 | 含义 |
|---|---|
| `ai_enabled` | 总开关 |
| `ai_endpoint` / `ai_api_key` / `ai_model` | 端点 / key（**后台可改，展示时打码**）/ 模型 |
| `ai_prompt_new_post` | 新帖审核提示词 |
| `ai_prompt_report` | 举报复核提示词 |
| `ai_review_posts` / `ai_review_comments` / `ai_review_on_report` | 三个范围开关 |

**流程上老站已经有了「试跑」**（这正是编辑器最该有的功能）：
- `ai_target_text(kind, id)` —— 把一条真实内容**取出来渲染成将要发给模型的文本**（后台可预览，保证所见即所发）；
- `run_ai_review(kind, id)` —— **人工点一次「立刻审核」**：真发一次请求、拿到判词与理由、**落状态并留痕**；
- `ai_reviews` 表记 `source(new_post|report|manual)` —— 人工那次就是 `manual`。

**判据写在工具描述里，不写在提示词里**（`core::review::ai_tools`）：三个工具 approve/pending/reject，
各自一句话说明什么时候用它；提示词只说社区规则。这一点在编辑器里要显式呈现：让管理员看到「三个工具」而不只是两段提示词。

## 二、open-webui 里值得抄的（已在 `.tools/ref/open-webui`，commit f8ae8a6）

我们**不要**它的代码（Svelte / 整套聊天产品），只要它的**信息架构与细节**：

| 它的文件 | 抄什么 |
|---|---|
| `src/lib/components/admin/Settings/AdminSettingSection.svelte` | 设置页的分区：一个标题 + 竖排若干行，行间距统一 |
| `.../AdminSettingRow.svelte` | **左标签 / 右控件 / 下方小字说明**；并且它给控件**生成 label id 做无障碍关联**（`<slot {labelId} />`）—— 这个细节直接抄 |
| `.../AdminSettingField.svelte` | 需要整行宽的控件（提示词多行框）用「上标签 + 下控件 + 小字说明」的块式 |
| `.../Settings/Models.svelte`、`Connections.svelte` | 「模型 + 端点 + key」这组设置的组织方式（先连接、再模型、最后默认参数） |
| `.../Settings/Models/ModelDefaultsPanel.svelte` | 默认参数（温度 / 上限）与「改了就生效」的交互 |

**open-webui 与我们不同的地方**（别照搬）：它是多租户聊天产品，设置项分得很细、有 provider 抽象；
我们只有一个端点 + 一个模型 + 两段提示词，做成**一屏**即可，不要为「以后可能多个 provider」提前抽象。

## 三、这一屏该有什么（devroom 里做，编号自定）

1. **开关区**：总开关 + 三个范围开关；未配 key 时整屏显示「未配置」而不是假装可用；
2. **模型区**：端点 / 模型 / key（**打码显示 + 只写不回显**）；端点与模型的默认值来自配置，页面只覆盖；
   已知（2026-10-14 读文档）：base_url 是 `https://api.deepseek.com`（**不带 /v1**），模型名是 `deepseek-flash`；
3. **提示词区**：两段提示词（新帖 / 举报复核），各自可编辑 + 单独保存 + **显示最后保存时间与保存人**；
4. **工具区（只读）**：把三个工具的名字与描述列出来 —— 让管理员看清「判据在这里」，减少把判据塞进提示词的冲动；
5. **试跑区（最重要）**：
   - 选一条真实内容（或粘贴一段）→ **显示将要发给模型的完整文本**（与 `forum.PostReviewText` 逐字一致）；
   - 点「立刻审核」→ 调一次真请求 → 显示**判词 + 理由 + 用的模型 + 耗时 + 原始返回**；
   - 明确标注这次试跑**会/不会**改帖子状态（老站的 `apply_state`：手动那次是 true）；
6. **历史区**：读 `ai_reviews`（倒序、按目标过滤），显示时间 / 目标 / source / verdict / reason / model / ok；
   这一屏同时是「出问题时的现场」——所以要能按 target 过滤。

## 四、后端已有的（照着接，不要新造）

- 判定三态与工具定义：`forum/review_ai.go`（`AiTools` / `AiVerdictFromToolName` / `ReviewState`）；
- 发给模型的文本：`forum.PostReviewText` / `CommentReviewText`；
- 留痕表：`ai_reviews`（迁移 `0020_ai_reviewed`）；
- 队列：`ai_reviewed` 这个 bool + `ResetTopicReview`（作者改正文 → 回待审）。

**缺的后端（做编辑器时一并要）**：设置项的读写端点（把上面那几个键落进 `site_settings`，config 只做默认值）+ 试跑端点。
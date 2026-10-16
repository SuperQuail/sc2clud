# 10 · dev 排查缺陷清单（工作文件：第十二轮起）

> 用途：用户实测缺陷的**当前工作账本** —— 每条一行形状：症状 / 根因（带 `文件:行号` 与实测数字）/ 修复 commit。
> 读法：先 grep `**D<n>**`；第一至第十一轮（D1–D55）在 [`10-dev排查-缺陷清单-归档-1-11轮.md`](10-dev排查-缺陷清单-归档-1-11轮.md)。
> 纪律：**实现细节归 commit message**，这里只留决策与证据（否则每轮都会把同一个故事重写一遍）。
## 1p. 第十二轮（用户 2026-10-15 20:4x 提九条 + 裁切弹层补报；三子代理并发 + Lead 直修；账本处理列随交付补齐）

| # | 事项 | 事实/根因 | 处理 |
|---|---|---|---|
| **D60** | 下载源名称按 URL 猜、猜不中显示「其他」 | topic_sources 一直有 label varchar(60) 列（0004），用户自定义名早有位置——是前端没用它、按 URL 形状猜 | **已修**（2d4fbdc）：行主名 label 优先，空了回落站点名，两无则把原始链接主机名当注脚（不猜名，摆事实）；TopicSource/toDesignSource 补 url 透传；topic-view/topic 双测试。prod 现网截图证据 shots/b1-prod-miyin-sources.png |
| **D61** | 下载链接走站内中转 | 前端把下载源点击当路由 | **已修**（dc19113）：prod 实测整行 a[target=_blank] 已在线上（db6b72c 落地）——本单补 rel=noopener noreferrer + 钉子改断言，后端零改动 |
| **D62** | 用户组无法限制发帖权限 | 实测真根：**服务层 deny 判定正确，缺在 boards.acl_enabled 默认=false（prod 三分区全 false）时 canSpeak 第 3 步把整个矩阵连同 deny 跳过**——管理员戴上的禁令从不生效 | **已修**（b41fda7）：acl.go 白名单关闭分支先判显式 deny（角色行/组行任一）再走等级门槛；TestDenyAppliesEvenWhenAclDisabled 红→绿（禁发组 201→403 board.acl_denied + 角色行 deny 与无 deny 对照组）；can 语义不变。**黑盒提示：默认分区（acl_enabled=false）栽组 deny_post → 发帖应 403** |
| **D63** | 新帖不进 AI 审核 + 无审核历史 | 上一任 C 的遗作红钉（forum/internal/site/ai_toggle_default_test.go，未跟踪）：site.SettingSpecs 里 ai.review.enabled **声明默认值写成 off**（设计稿 d7 §2.2 = true），全站按「缺行回落声明默认」→ AI 审核默认**死**（入队与消费都正常，worker 第一步被 SettingBool 短路）。这就是「新帖不送审」的根因 | **已修**（d058a8a）： DAR默认 → on，红钉两条（遗作收编）转绿，internal/site 全套过（Lead 复跑同绿）**(834eef3)**：GET /admin/ai/events（cursor 分页、包络同审计日志、post.review）+ 审核屏「历史」页签（Prop 驱动）；events_test 两条 + review 屏 8 用例；aireview/site Go 双包 Lead 复跑全绿。**score 字段不编**（库与外呼协议都无数字分，编即假真源）；演示层 props 由 Lead 补（1958c6e）；迁移素材文档两句同步（1958c6e） |
| **D64** | 删除的评论用户侧仍显示 | 真根：TopLevelReplies 的作者例外（p.author_id=viewer）让作者软删自己的顶层回复后自己的列表照常显示（PostDTO 无 visibility，前端无从打标） | **已修**（4d7c5e6）：列表口径=「非 normal 谁都不列」；单条寻址 postRef 保留作者例外（分享链不受影响）；TestDeletedReplyVanishesFromListForItsAuthor 红→绿；前端失效本有（removeReply），D67 再补信息流面 |
| **D65** | 验证码大小写敏感（用户过不去）+ 错误只显示「编号」 | 前任 D 丧命前的 dev 实测：**代码语义已正确**（k7m2 答大写题→过、两端 trim、拒全宽）——缺的是钉子（TestVerifyIsCaseAndSpaceInsensitive 名字与替身不符），错误行半条另算 | **已修**（d01a1f9）：钉子补全四行为断言（实际位置 platform/captcha/captcha_test.go——非 auth/；auth 侧替身从假「区分大小写」公约改为真 ToUpper+TrimSpace 公约），行为代码零改动 **（01021e7）**：errors.ts 新增 apiErrorLine 全站唯一实现（message 优先/fields 次之/requestId 只作「（错误编号 …）」附注）+ 15-admin/bits errorLine 委托 + register-verify 失败文案对齐 ErrTokenInvalid；errors.test.ts 钉顺序。**Go 复核（Lead）**：captcha 0.48s + auth 70.5s 全绿——D65 闭环 |
| **D66** | 评论区新评论在上（应老上） | 排序键/游标方向 | **已修**（46bdebd）：顶层回复与 Issue 顶层评论改 id 升序，键与游标方向一起翻（id>游标、ORDER ASC）；intCursor 空哨兵 MaxInt64→0（升序第一页恒假会永久零行的坑）；TestTopLevelRepliesListOldestFirst 钉页序+三连翻页+尾页 |
| **D67** | 首页卡片评论数过慢（点进才见真数） | 真根：卡片数读 ['topics',…] 缓存快照；写路径本身同事务重算无漂移（prod topic 11 的 last_reply_at 脱节是历史数据尾巴，ops 回填建议见下） | **已修**（9f066ec）：回复成功/删回复成功后一并失效 ['topics']+['profile'] 前缀；topic.test.tsx 断言两段缓存 isInvalidated |
| **D68** | 归档头衔不可见不可改，key 被占用永久卡死 | 真根：GET /admin/titles 复用公共 ListTitles（滤归档）→ 归档行消失；又无删除端点 → 旧 key 被 409 且无处可解 | **已修**（3b5af0c，后端活在 forum/internal/title 包——编外但非禁区，Lead 复核通过）：AdminListTitles 含归档；新端点 DELETE /admin/titles/{id}：同事务先数引用，有持有/佩戴 → 409 fields 人数（不级联毁数据），审计带 deleted；管理屏行内「删除」+确认弹层，409 走 errorLine；TestAdminListIncludesArchived + TestDeleteTitleRefusesWhileReferenced 红→绿；D49 校验未动 |
| **D69** | 封面/壁纸弹层悬在左上角；白色覆盖层盖住裁剪区无法操作 | 实机复现（cdp-shot 注入文件 + elementFromPoint）：①「封面/背景」native dialog **margin:0px** 钉左上角——Tailwind preflight 吃掉 UA 的 dialog margin:auto，showModal 的 fixed 元素就钉角落；②裁剪框命中测试 = **外层 picker dialog**（hit=DIALOG、inside:false）——ImageCropper 的 Ring Dialog 是封面 dialog 的**子孙**，native modal 后代进不了 top layer 的正确层级 → 白覆盖/拖不动 | **Lead 已修**（13ab193）：①显式 m-auto + inset-0 + h-fit 找回居中；②ImageCropper Dialog 改 createPortal(document.body)——两颗 dialog 成兄弟（头像链路一直正常的形状）。cdp-shot 工具加 cookie/nav/diag2/stufffile 动作（会话注入+文件注入+命中诊断可复用）。**归档/清理：demo 诊断会话已删（sessions user1→0，恰证明重置自封也把 D56 的临时会话踢光——D56 与 D69 两轮共用同一把「踢全会话」事实）In dev** |**13ab193 一轮：dialog 居中 + portal 到 body（dev 复验：居中好了但 picker 反盖 cropper——两颗 top-layer modal 并存的层叠不可控）。**01a3b0f 二轮：改行为级——ImageUploader 新增 onCropOpenChange，cropper 打开期间 CoverPicker 把自己的 native dialog 暂时 close（React 状态不动 + suppressClose 锁 onClose），裁完/取消 showModal 收回；crop-frame 底 bg-foreground/5（contain letterbox 不再发白）。**dev 实机复验通过**（截图+digits： Picker open:false 收起、cropper 唯一 top-layer、命中可达、无白覆盖） | |
| **D70** | 「没能保存这条来源」500（编号 da414cc6…） | prod 只读日志：POST /api/v1/topics/:id/sources 撞 **ck_topic_sources_size**（23514 → common.internal 500）——size_text 的格式正则约束 + 服务端零校验直写 DB | **Lead 已修**（014d830）：用户拍板「不托管文件、大小就是普通文本」——0057 迁移 DROP 约束 + 列宽 16→64（自由文本不再触第二个 500）；ent schema 同步（MaxLen 64）；**ck_topic_sources_url 的 https 保留**（协议防线）。**已提交 014d830；dev 部署时随迁移生效** |

### 1p-production. 本轮按用户指令直接上生产（2026-10-15 23:30；用户：「没什么时间了，没发现问题就上生产」）

- 部署：prod `8414f37 → de609af`（迁移 56→**57**），deploy 全 9 步走完，备份 `/srv/sc2clud-prod/backups/pre-deploy-de609af-20261015-153035.dump`；健康 200、bin/web 版本一致、systemd active、错误日志 0。
- 后验（只读）：`ck_topic_sources_size` 已从 prod 库消失（D70 生效全网）；site/boards/topics/首页 全 200；房间目录 prod 照旧不发布（install.sh 设计：产品产物无 devroom）。
- 本轮全部 13 条（D60-D70 计 11 条 + D69/D70 补报）**同时生效于 dev 与 prod**。


<!-- 1q 起：第十三轮（D71–D75），三子代理 + Lead 收敛 -->

### 1q. 第十三轮（用户 2026-10-15 01:5x→07:4x 报五条：D71–D75；三子代理并发修复，Lead 收敛门禁）

| # | 现象 | 根因（实测证据） | 处理 |
|---|---|---|---|
| **D71** | **帖子正文不该出现在评论区**（用户：「第 0 楼只是编号安排，正文不应作为评论显示」） | posts 表里**正文本身就是 floor=1 的一行**（0004 + InsertTopicBody），`TopLevelReplies` 的 roots CTE 把 1 楼当顶层回复返回 → GET /topics/:id/posts 第一条就是正文，评论区复读主楼；且 `reply_count` 口径 floor>1，列表与计数差 1；`CreatePost` 又允许 parent 指向 1 楼（这些楼中楼挂在正文名下，摘掉正文就成孤儿） | **已修**：① 列表剔除——roots CTE 加 `AND p.floor > 1`（3dadd94，口径与 reply_count 齐平）；② 写路径重挂——parent 的 Floor==1 时**按顶层回复落库**（32c8b3e，「回复正文就是回复帖子」）；③ 历史数据回填——迁移 **0058** 把挂在 1 楼名下的旧回复改为顶层（7835423，down=有注释 no-op，照 0019 有损回滚先例）；④ 前端双保险——toComments roots 过滤 `floor !== 1` + Post 补 `floor?`（cd15122，防 Web 先上/后端未上时的时序差）；⑤ 红→绿（ca59f2b 红批：TestListPostsExcludesTopicBody / TestReplyToTopicBodyIsTopLevel；reply_list 平移楼层断言、TestReplyParentRules 列表断言 2→1） |
| **D72** | 无法撤销用户头衔 | `DELETE /admin/users/:id/titles/:titleId`、`RevokeTitle`（撤销佩戴中的后端自清 `equipped_title_id`）**自 D1 就挂好了**——是前端零调用 | **已修**（961d29f）：GrantTitleDialog 在「授予」之下列**已持有清单**（公共读 GET /users/{handle}/titles；handle=行上 username，已对 admin-types/ByUsername 核实），每行一颗 danger「撤销」走**既有** `revokeTitle` 客户端（不造第二个真源）；撤销经容器 `onRevoke` 发真请求、成功弹层自己失效 `qk.userTitles` 就地少一行、失败 errorLine 就近报；users-dialogs.test 钉 DELETE 路径与清单缩减 |
| **D73** | 无法设置帖子置顶/精华 | 后端 `POST /topics/:id/pin|feature`（perm `topic.pin`，同一权限点管两事，拍板 §10.9）**一直在线**，前端零调用 | **已修**（5723106）：lib/api 补 `setTopicPinned/setTopicFeatured`（体 `{pinned}/{featured}` 照 handler.go:430-453）；话题动作条加**置顶 / 精华**两颗 ghost 开关（active 反映详情现值，可选 props 整组不给不渲染，房间容器零改动）；routes/topic.tsx 在 `can('topic.pin')` 时挂 mutation（onSettled 失效 qk.topic，失败并入 steps 回执）。topic.test 钉：版主见两颗开关且点击经真实 api 层打到端点、非版主整组不渲染 |
| **D74** | 评论时间显示冗余（应精确到分钟） | `toComments` 把 `created_at` 原样 RFC3339 透传（线上显示 `2026-10-16T07:31:02.123+08:00`） | **已修**（66bbab4）：lib/format.ts 加 `formatMinute`（`Intl.DateTimeFormat('sv-SE', short/short)` → `2026-10-16 07:31`，Invalid Date 回空串）——「现有库」就是房内 format.ts，**零新依赖**；toComments 切过去；format.test 2 例 + mappers.test 3 例（含非法串回空、无 floor 老响应不误伤） |
| **D75** | 退出登录应移到设置页最底部并标红 | 退出按钮长在 AccountPanel（页面中部）；Ring `Button danger` 全站唯一危险色口径已有 | **已修**（b095282）：AccountPanel `onLogout` 改可选（不给且非 loggedOut **整格不画**，房间 11-profile 照传、其测试零改动）；settings.tsx 页尾新增居中 danger 按钮（`data-testid=settings-logout`）；settings.test 钉三件事：settings-logout 存在且承载块是页面根**最后一个直接子元素**、AccountPanel 区不再有原退出钮、点击打 POST /auth/logout |

**收敛门禁（Lead 在最终 HEAD 9 提交合并态复跑）**：Go `forum` 88.7s + `pgsql` 11.6s 全绿（-count=1）；web `tsc` 0、vitest 全量 **339/339**、`vite build` 过、budget（首屏 JS 177.8/180 KB、CSS 37.9/40、最大 chunk 98.7/120）、size/tokens/urls/controls/security/ui-usage/conventions 全过（size 超限仍是登记在册的 3 个：boards 565 / topic.test 655 / screens fixtures 537）。全仓 lint 有 23 条**既有**警告（only-export-components 等，不在本轮文件）——常态处理项，不入本轮门禁。
### 1q-production. 本轮按用户既定口径直接上生产（2026-10-16 08:2x）

- dev：`dep loy.ps1 dev` 一次完成（外层超时被杀，**嵌套流水线自己跑完了全部 9 步**；重跑只撞同版本防呆「pick another version」——不是失败）。health 200、bin/web 版本一致、**迁移 57→58**。
- dev 黑盒：GET /topics/{id}/posts → 列表仅有 `floor:2`（reply_count=1 同口径），`floor:1` 正文不出现在评论列表。
- prod：`de609af → 70ff692`，164.6s，迁移 57→**58**（含 0058 历史挂楼回填），备份 `/srv/sc2clud-prod/backups/pre-deploy-70ff692-20261016-001715.dump`；health 200、bin/web 版本一致、公网 / 200 即本构建、部署以来 journalctl **ERROR=0**；/topics 200、/admin/ai/events 未登录 401（既有路由+守卫健康）。
- prod 黑盒：GET /topics/{id}/posts → `floor:2 / floor:5`（无 1 楼），首条内容为用户回复。
- 权限审查（用户指派，只读）：续写 `完全重构/RBAC权限树设计.md` §9 源码实测（角色×24 权限点矩阵 / 叠加次序 / superadmin 专属 / 九条发现含 schema_check admin 期望 16→17 自检常鸣、user.mute 与 resource.publish 两个「已授不判」点）；角色定位声明按用户要求置顶：**管理员=网站辅助管理者；超级管理员=网站开发/维护/所有者**。

---

### 1r. 第十四轮（用户 2026-10-16 08:2x 提两条优化；四子代理并发，Lead 收敛）

| # | 事项 | 事实/根因 | 处理 |
|---|---|---|---|
| **D76** | **页面里的「因为 XX 设计所以 XX / 因为某文档所以怎么样」文本全部剔除**（用户点名管理页最严重） | 可见文案里混入对设计稿/方案的**引注与自证**：管理页 25 处（`d7 §3.2`、`§9.8`、`（拍板 §8.11 U2）`、`（DB §4.11）`、`（技术方案 v2 §8.2）`…），其余产品页 24 处；**后端下发的文案同样带**——`site/settings.go` 的 Hint（管理端站点设置屏每个开关下面）与已入库的 `permissions.description`（角色矩阵屏渲染） | **已剔除**：A `5b0ad69`（管理页 21 文件 66 处：ScreenHead/Panel note、Input help、KV hint、GateNote/DisabledReason、表格旁白、nav.ts 14 条、mock hint）；B `7dffdbe`（其余产品页 17 文件 24 处；**顺带修掉 17-appeal 把一行 `//` 注释当 JSX 文本渲染进页面的乱码**）；D `4839df7` + 迁移 **0059**（Hint 去引注；已入库的 topic.pin 描述用精确 UPDATE 幂等清库，不覆盖管理员手改过的值）。口径：**删引注与自证、保留功能信息**；代码注释（// 与 `{/* */}`）、`*.md`、`registry.ts`/`preview/**`（房间文档）与 `room-links.tsx`（房间专用「未做」标注）**刻意不动** |
| **D77** | **大量报错只显示编号、不显示具体原因** | 两条真根：① 前端 `client.ts` 用 `??` 接 message，**空串接不住** → 整行只剩「（错误编号 xxx）」；另有 8 处手写错误行各拼一遍（第二个真源）。② 后端 `httpx.Fail` 对未识别错误一律 `ErrInternal`，**真原因只进日志**——D70 那次 500 的真实原因是 PG check 约束 23514，用户只看到编号 | **已修**（C：34ec438/5c04b79/dd72907）：① 前端 `client.ts` 改空白兜底 + `errors.ts` 新增 `CODE_REASON`/`STATUS_REASON`/`fallbackReason`，`apiErrorLine` 正文 = message → fields 理由 → code/状态兜底（**绝不返回空**），编号恒在末尾；新增 `apiErrorLineWith` 供页面换业务正文；8 处手写处（appeal/compose/login/register/register-verify/settings/state/error-boundary）全部收编。② 后端按 SQLSTATE 归类 500 原因（23505/23503/23514/23502/22P02/40001/40P01/57014）写进 message，**code 仍 common.internal、status 仍 500**，表名/约束名/SQL 只进日志；`dbUnavailable`（pgx 连接类）→「数据库连接不可用」，**排在 isClosedConn 之前**（原先被吞成 200 空响应）；`ErrInternal` 文案补「详见服务端日志」。红→绿：web 7 条 + Go 4 条（含 D70 的 23514 场景，并断言不泄漏约束名） |

**环境事实（本轮踩到、写下来免得重踩）**：本会话 `spawnSync("node", …)` 起的是 **Harness 的 Electron**（`process.execPath` = `DeepSeek Harness.exe`）——它会**静默吃掉 vitest**（status 0、零输出），于是「vitest 全绿」可以是假绿；而 tsc/门禁脚本因为纯 Node 仍能跑出真输出。web 门禁必须用**真 node**：`C:\Program Files\nodejs\node.exe`（或 dsh 运行时 `…dependencies\node\bin\node.exe`）。子代理 B 提的 `ELECTRON_RUN_AS_NODE=1` 变体在 vitest 5 上仍失败，别用它。

**收敛门禁（Lead 用真 node / go.exe 复跑最终 HEAD）**：web `tsc` 0；vitest **346/346**（69 文件）；`vite build` 过；budget 首屏 JS **178.1/180 KB**；size（362 文件 / 3 条已登记超限）、tokens、urls、controls、security、ui-usage、conventions 全过。Go：`./internal/platform/... ./internal/site/...` 全 ok、`./internal/forum/...` 85.1s + pgsql 11.3s 全绿。
### 1r-production. 第十四轮同样直接上生产（2026-10-16 08:4x–08:5x）

- dev：`48dff12`（迁移 58→**59**），health 200、bin/web 版本一致；备份 `/srv/sc2clud-dev/backups/pre-deploy-48dff12-20261016-004459.dump`。
- prod：`70ff692 → 48dff12`，165.8s，迁移 58→**59**；备份 `/srv/sc2clud-prod/backups/pre-deploy-48dff12-20261016-004900.dump`（259724 B）；health 200、bin/web 版本一致、公网 / 200 即本构建、部署以来 journalctl **ERROR=0**，/topics 200、/admin/ai/events 未登 401。
- 双端黑盒（只读）：① `permissions.description`（topic.pin）=「置顶 / 精华（两个端点共用这一个权限点）」——**0059 在库里生效**；② **产物 JS 里「拍板」与「§」出现次数均为 0**（D76 真的进了线上包，不只是源码改了）；③ 错误信封带原因与字段：`/topics/not-a-uuid` → `参数错误` + `fields.id=格式不正确`（不再是空 message + 编号）。
- 回滚：`pg_restore --clean --if-exists -d <dsn> …/pre-deploy-48dff12-*.dump` + `current → 70ff692`。

#### 1r-addendum. D72 二轮（2026-10-16 09:1x，用户：入口改名「头衔编辑」+ 改复选框列表）

- 实现（8b0b332）：`GrantTitleDialog` → **`TitleEditDialog`**；入口按钮与弹层标题都叫**「头衔编辑」**；弹层改为一列 `Checkbox`——行 = **目录未归档 ∪ 该用户已持有**（并集，否则持有已归档头衔就永远撤不掉），`佩戴中`/`已归档` 用 Pill 标注；**勾上即 POST 授予、取消勾即 DELETE 撤销，无保存按钮**；逐行 pending 且禁用其它行，成功 `invalidateQueries(qk.userTitles)` 回服务端真值，失败 errorLine 就地报错且**不乐观翻转**。接线合并：`onGrantTitle`+`onRevokeTitle` → `onSetTitle(userId, titleId, held)`（routes/admin/users.tsx 按 held 分发）。
- 验证：真 node 下 vitest **350/350**（69 文件，净增 4 例）、tsc 0、build+budget（178.1/180 KB）+ 7 条静态门禁全过（Lead 独立复跑，非子代理自报）。
- 上线：dev `8b0b332`（备份 pre-deploy-8b0b332-20261016-012108.dump）、prod `48dff12 → 8b0b332`（165.3s，备份 pre-deploy-8b0b332-20261016-012415.dump）；双端产物含「头衔编辑」×3、旧 testid `title-revoke-` 计数 **0**；prod 部署以来 journalctl ERROR=0，DELETE 端点未登录仍 401（路由在）。
- 注：权限点显示名「发头衔」（nav.ts / audit / mock fixtures）**未改**——那是 `title.grant` 的点名，不是按钮文案。

---

### 1s. 第十五轮（用户 2026-10-16 10:3x–11:1x 连报三条 + 追加「错误设计遗毒清理」与「issue 可举报」；五子代理 + Lead 直修）

| # | 事项 | 事实/根因（实测） | 处理 |
|---|---|---|---|
| **D78** | 讨论帖不该开问题反馈（Issue）区 | 反馈入口与「问题反馈」页签在共用 View 里由 props 驱动，**所有 kind 一视同仁** | **已修**（c1698ec，W1）：宿主按 `kind !== 'discussion'` 决定是否传 `issueCount/issueHrefFor/feedbackHref/onOpenIssue`；`topic-view` 与 `topic-tabs` 新增**显式**开关 `issuesEnabled`（默认 true），false 时页签 + 正文末尾 nudge + 右栏 nudge 整块不画；房间一字未改（不传=现状）。红→绿：新建 `topic.issue-scope.test.tsx`（讨论帖那条给的是 `issue_open_count=7` 的非 0 值，不是「计数 0 恰好没药丸」）；全量 353 绿 |
| **D79** | **「已经手动通过的帖子编辑，帖子页面不更新」**——强制刷新也不行 | **不是缓存**（用户实测 + nginx 无 `proxy_cache`/`expires`、API 无缓存头）。库诊断抓到实据：prod 的 topics **11 / 14 / 18**、dev 的 topic **53** 的 `posts.floor=1` 是 `visibility=deleted`（内容还在：549/26/5 字）。根因链：D71 之前「正文被当评论渲染」，作者在评论区点删除 → `DeletePostRow` 把**正文行**软删（这是既有的有意行为：「1 楼只软删自己，标题还在」）；此后**两条写正文的路径都只写 `content_*`**，visibility 永远停在 deleted —— ① `UpdatePostContent`（没过审的帖直接写 posts）② `PromotePendingRevision`（已过审帖「通过再替换」）—— 所以人工/AI 明明批了，读者看到的仍是「正文已被作者删除」，作者再怎么改也救不回来 | **已修**（6fcee69，Lead 直修）：① `UpdatePostContent` 对 `floor = 1` 一并置回 `visibility='normal'`（回复不在此列，避免改稿把删掉的回复冒出来）；② `PromotePendingRevision` 放行时一并置回可见（放行改动=上台可见）；③ **迁移 0061** 修历史残留：只修「帖子本身还在、只有正文行被软删」（`t.visibility='normal'`），整帖被删的不动；down=有注释 no-op（照 0019/0058 先例）。红→绿：`body_visibility_revive_test.go` 两条（临时回退两处 SQL → red status=1；恢复 → `ok 12.296s`） |
| **D80** | **待替换改动（编辑帖子触发）不触发 AI 自动审核** | 三层：① `UpdateTopic` 编辑路径**只入队 `search.index`**，正文进了待审槽后就再没有 AI 任务（发帖那条路有 `ai.review`，注释还写着「AI 也重新看一次」）；② `aireview/sql.go` 的 `sqlSubject` 读 `posts.content_md`（**线上旧正文**），待审稿在 `pending_md` —— 与管理端预览的 `COALESCE(pending_md, content_md)` 不同源；③ `ReviewTopic` 落库不是 revision-aware：只改 `topics.review_state`，**没有**「放行草稿要替换线上正文」那一步（人工放行走 `PromotePendingRevision`）→ AI 置了 approved 改动也永不上台；④ 另需迁移把 `ck_review_events_trigger` 的 `edit` 放进来 | **已修**（4114c9e 主体 + ddcbc3a 0060 回滚用例 + 39c4f7d 无待审槽 approve 用例，G1）：编辑正文即与 `search:index` 同事务入队 `ai.review`（payload `{topic_id, trigger:"edit"}`、`UniqueKey=review:edit:<id>`、Priority 20 / MaxRetry 2）；`sqlSubject` 改 `COALESCE(rv.pending_md, p.content_md, '')`（与审核队列预览同源）+ **迁移 0060** 把 `ck_review_events_trigger` 放宽到 `create|report|manual|edit`（down 必须先删 `trigger='edit'` 行再还原三值约束）；`trigger=edit` 下 **approve 走 `promoteEdit`**（topics 状态 + posts 正文/html + excerpt + 快照 content_* + 清待审三列，与 `pgsql.PromotePendingRevision` 后置条件**逐列相同**，`approved_by=NULL`），**reject/review 只写 `review_events`**，不动 state/visibility/note/待审槽。红→绿：forum「实际 0 条（队列里只有 search:index）」；aireview 4 条红在 `23514 ck_review_events_trigger`；0060 down 去掉 DELETE 时回滚用例红；147 PASS / 0 FAIL。**它暴露的两条真缺陷另派 G3 修**：① AI 放行后**没人重建搜索索引**（`indexTopic` 对未过审主题是删索引行，人工放行有 `search:index`，AI 因跨驱动事务够不到）→ **create 放行的帖从 D63 起就一直不在搜索里**；② `sqlSubject` 无条件优先 pending 让 **report 复核也审草稿**（reject 还会把线上帖 hidden）→ 改成调用点显式决定（edit 取草稿、create/report 取线上、预览取「将要被审的那一版」） |
| **D85** | **（工具）前后端接线检查器**（用户要求：导出「后端有、前端没接」这一类，避免再犯） | 同一个形状反复出现：D72 / D73 / D80 都是「端点早就有、前端零调用」 | **已落地**（323e1f1）：`web/scripts/check-wiring.ts`（真源 A = `forum/internal/**/handler.go` 路由，真源 B = `lib/api/**` 的 `api/apiPage/apiEnvelope` 首参，含拼接与常量顺推）+ `wiring-baseline.json`（23 条孤儿 + 2 条幽灵，**每条带 reason**）+ 13 个自测用例。首跑即交出 **18 个真孤儿**（lock / 楼中楼分页 / 拉黑 / `/issues/kinds` / 登录设备 / 关注家族 / launcher 家族 / markdown 预览 / 头衔目录 / 旧用户搜索）与 5 条假阳性。**按用户口径改成按需调用**：`pnpm wiring`，已从 `pnpm check` 链撤出（不阻塞部署）；**写进开发规范** `完全重构/前端架构设计-v1.md` §13.3——「前端做完一屏主动跑一次」+ 单页 `--page … --expect …` + 基线纪律（reason 必填、过期条目要清）。待办：工具改进轮（`--page` 改调用点粒度、真源扩到内联 `api()`/href 与 `app`/`probe` 层路由，消掉 7 条假阳性） |
| **D82** | **（功能）issue 可被举报 → 交 AI 审核 → 归档**（用户原话：参考评论举报的流程递交 AI 审核；追加口径：**归档、只在管理后台可见、不再显示在 issue 区**） | 现状三缺：`ck_reports_target_type` 只允许 `topic/post/user`（0006）；`report/reports.go:69` **只有 topic 举报**才触发 AI 复核；`post_issues` 只有 `status(keep_open/closed)`、**没有归档/隐藏列**，且 AI 的判定链路（`review_events.topic_id` FK、`sqlSubject` 读 topics+posts）是**主题形状**的，issue 不是主题；**管理后台也没有任何 issue 落点**（无 `/admin/issues`、15-admin nav 无此项） | **已交付并上线**（后端 D1：18432af 迁移 0062 / 7b76af8 forum 归档+公共读过滤 / 5e91585 aireview `ReviewIssue` 与 `ai:review` 的 issue_id 分派 / c969416 审计记 IP / e257e21 gitignore；前端 D2 六提交：issue 举报入口复用 `ReportPanel` + 管理端「Issue 管理」屏；**dev `c969416`、prod `d95df82`，迁移 62**）。落地：① 举报 `target_type` 加 `issue`（阈值/幂等复用），`ReportReviewInput` 加 `IssueID`，触发从「仅 topic」扩到 issue；② 管理端三条 `GET /admin/issues`（`archived=0|1|all`，包络额外带 `counts={active,archived,all}`）+ `archive`/`restore`（`post.review`，200 `{ok:true}`，写 `audit_logs` 含操作者 IP；重复归档幂等不写第二条审计）；③ **公共读四条 + `issue_open_count` 一律排除已归档**，已归档详情对不持 `post.review` 的人 **404**（与不存在同形）；④ AI：与 `ReviewTopic` 共用开关/密钥/配额/外呼/留痕，**approve 不归档、reject 归档（`archived_by=NULL` + 审计 `source=ai`）、拿不准只记事件**；本期不发图（issue 无配图通道）；判定落 `review_events.issue_id`（`topic_id` 为 NULL，0062 的 CHECK 要求恰好一个非空）。两处取舍：**issue 到第二阈值（Human）不入队也不标记**（`post_issues` 没有 `review_source` 可落，而举报本就在管理队列里）；**`counts` 不跟 `?archived` 变**（否则切到已归档档时「未归档 N」会变 0，而屏幕上正列着那些条目）。测试：0062 回滚 / 归档可见性与恢复 / 路由端到端（包络·PathGuard·401·400）/ `ReviewIssue` 四判定 / issue 阈值入队 / 前端举报入口与归档恢复（mockFetch 断言 URL·方法·体）；契约冻结生效——`status` 两侧统一为 `keep_open|closed`（此前担心的「两边两个词」未发生） |
| **D83** | 遗毒清理 · **「正文可被删除」**（用户定调：这是完完全全错误的设计） | 唯一入口是 `Service.DeletePost`（注释原写「1 楼只软删自己，标题还在」）；删掉后读者看到「正文已被作者删除」，且**没有任何路径能恢复**（见 D79）；DTO 里还留着 `content_deleted` 与 `map.go` 的 `deletedHTML` 这条渲染链 | **已修**（4083369 + 483c298，A + Lead）：`DeletePost` 在权限判定之后拒绝 `floor = 1`（`invalid("id", "主题正文不是回复，不能在评论区删除；要删整帖请用删帖")`），删回复照旧、`RecountTopic` 的 floor 守卫随之成为死分支一并去掉；**拆掉 `content_deleted` 整条链**（dto 字段 + `pgsql/topics.go` 的 SELECT/scan + `map.go` 的 `deletedHTML` 分支；全仓零命中，前端本就没读）；那两处 visibility 恢复降级为「历史残留/非服务层路径」的防御，`DeletePostRow` 明确标注为不设防的底层工具。红→绿：`TestDeletingTopicBodyIsRejected`（旧码 FAIL「期望报错，实际成功」）；floor 全量扫描结论：其余 `floor=1` 用法全部正当 |
| **D84** | 遗毒清理 · **「正文出现在评论区」**（前端与房间） | 逐个 mock 核过：**并不存在**「把正文建模成第一条评论」的数据（正文一直由 `topicBody()`/`content_html` 单独渲染）；真残留是两处——删帖确认文案「正文会被标记为作者删除」把 D79 的半死状态写成正常行为，以及房间 13-issue 里「楼主」徽标点错人（任意新回复都盖 `op:true`、两条数据作者与发起人对不上） | **已修**（2e33b83，B；2b04902，Lead）：删帖文案改成「标题与正文一起不再可读」；13-issue 去掉错误的 `op`（只留发起人本人那条）；新增 `topic.body-not-comment.test.tsx`（混入 `floor:1` 的响应里正文一个字都不进评论区、2 楼回复照旧、表头计数=回复数，红→绿钉住 `mappers.ts` 的 `floor !== 1` 兜底）；管理端 AI 配图上下文改标「正文配图 / 未挂楼层」，不再把正文的图标成「N 楼」。刻意保留：`mappers.ts` 兜底、`ui/comment/**` 的「楼主」徽标（主题作者发言仍正当）、后端契约与 admin DTO 里的 `floor` 字段说法 |
| **D81** | 审核动作后帖子页不更新（前端新鲜度） | 审核动作成功后只失效了 `['admin','review']`，**没失效被审主题的详情/回复/列表**；帖子页详情 `staleTime=60_000` → 同浏览器里点完「放行」再打开帖子页拿到的是旧缓存 | **已修**（d4ecc16，G2）：先按真浏览器路径造复现（**第二个**审核员身份 + 时钟前进 + 原样回传 `expected_updated_at`）——服务端那条路**首跑即绿**，证明无缺陷；真根因在前端（审核成功只失效 `['admin','review']`），现补 `qk.topic(id)`、`qk.posts(id)`、`['topics']` 前缀 + 断言失效集合的 vitest（红起：`expected [["admin","review"]] to include ["topic","1111…"]`）。边界：失效只作用于审核员**自己的**浏览器，别人在自己的 60s staleTime 窗口内仍可能看到旧版（缓存新鲜度固有边界，非缺陷） |


| **D86** | **中文昵称 7 个字就注册 500**（用户报 request_id `c3961890d12c3a1a`） | 长度三处口径不一致：`users.nickname varchar(20)`（Postgres 按**字符**）、服务层 `validateNickname` 按 **rune**、而 ent `field.String().MaxLen(n)` 按**字节**（`ent@v0.14.6/schema/field/field.go:246`）——7 个汉字（21 字节）过了服务层却被 ent 挡下 → `common.internal` 500。prod 日志同类失败 **6 次**（最早 10-15 20:02） | **已修**（39c4e9a + d95df82）：31 处「人可能写中文」的字段 `MaxLen` → `MaxRuneLen`（昵称/简介/话题标题与摘要/私信正文/举报理由与补充/Issue 标题/公告/横幅/权限·角色·头衔的描述/收款码标签/来源名/捐赠留言…），机器串（hash/token/状态值/域名/IP/slug）保持 `MaxLen`；规则写进 `ent/schema/board.go` 顶部。红→绿两条：auth 服务层（7 个汉字合法、20 在界内、21 是字段级 400）+ app **HTTP 层**（真实注册 7 个汉字并原样落库）；auth/user/site/title/media/notify 全绿 |
| **D87** | **注册限流过激**（用户报 request_id `42c1eee284e6504a`：`429 auth.too_many_requests`，ms=0） | 注册原为 **3 次/小时/IP**，而限流器是**固定窗口**——被拒要等满整窗，于是「3 次重试＝锁一小时」；更糟的是它在**一切校验之前**计数，**我们自己的 500 重试也烧额度**（同一 IP 先 6 次昵称 500 再 429，正是这条链路） | **已修**（9c8caf2，口径由用户定「失败与成功分开算」）：尝试池 `auth:register:attempt:ip` **60 次/小时**（进端点第一件事扣，手误与 5xx 重试吃它，也挡住无成本刷 argon2/发信）；成功池 `auth:register:success:ip` **3 次/小时**（**事务内、行插入成功之后**才扣 —— 预检之后的失败不吃额度；超额即在事务内拒绝并回滚，不留「建了号却 429」的幽灵账号）；找回密码 `auth:mail:ip` 3/小时 → **5 次/10 分钟**；**登录两道闸不动**（撞库面，放宽属安全权衡，建议值 20/分钟已报用户）。新增 `ratelimit_policy_test.go` 钉住四个 `(key, 额度, 窗口)` 含「失败的注册不吃成功额度」；`d2-auth.md` §7.1/§9.5 同步 |
| **D88** | **接线检查器交出的工单**（首跑 197 路由 / 18 真孤儿，见 D85） | 「后端有、前端零调用」的历史欠账 | **首批接 10 条**：WA `ab5f36a`（`POST /topics/:id/lock` 锁帖开关 + `GET /issues/kinds` 值域驱动四个入口/筛选/标签）；WB `0e7c1c5`（登录设备列表与踢设备、分区/主页关注者列表、我关注的分区与人、拉黑/解除拉黑）；两条都从 `wiring-baseline.json` 删除并自证。**剩余 13 条豁免** = 5 条假阳性（扫描面：`audit-logs/export`、`launcher/assets/:id/go`、`/me/password`、`notifications/stream`、`sources/:sid/go`）+ 8 条真「本期不做」（launcher 发布/资产 4 条、`POST /markdown/preview`、`GET /titles`、`GET /users/search`、`GET /posts/:id/replies`）。**用户 2026-10-16 拍板：launcher 运营台之后再做**（理由已写进基线 reason：启动器分发整体未启用 —— dev/prod 的 `releases`/`release_assets` 均 0 行、prod 公开读 `/launcher/latest` 实测 404、`/launcher/releases` 空数组、15-admin 从无此屏；要做时先做管理端一屏）；其余三条（`markdown/preview`、`titles`、`users/search`）待定。`GET /posts/:id/replies`（楼中楼深分页）WA 按边界拒绝并给出三条理由（要改 `CommentReplies` 公开 props、归属要造第二张表、三处测试注入点），**单独立项** |

### 1s-production. 第十五轮上生产（2026-10-16 11:2x–11:3x；dev 与 prod 同为 b2f9de1）

- **dev**：`deploy.ps1 dev` → `b2f9de1`，迁移 59→**61**（0060 `ck_review_events_trigger` 加 `edit`；0061 恢复被软删的正文行），health 200、bin/web 版本一致；备份 `/srv/sc2clud-dev/backups/pre-deploy-b2f9de1-20261016-032855.dump`。
- **prod**：`8b0b332 → b2f9de1`（158s），迁移 59→**61**；备份 `/srv/sc2clud-prod/backups/pre-deploy-b2f9de1-20261016-033157.dump`（262823 B）；health 200、bin/web 版本一致、公网 / 200 即本构建、部署以来 journalctl **ERROR=0**。
- **后验（只读，双端）**：
  · `ck_review_events_trigger` = `CHECK (trigger IN (create,report,manual,edit))` → 迁移 0060 在库里生效；
  · **prod `floor=1 AND visibility='deleted'` 从 3 → 0**：迁移 0061 把 topics 11/14/18 的正文行恢复成 `normal`（用户报的「正文已被作者删除 + 任何编辑都改不动」当场闭环）；prod 现在所有 `floor=1` 都是 normal；dev 那 1 条属「整帖已删」（`t.visibility <> normal`），按设计跳过；
  · 新文案进了产物：`标题与正文一起不再可读`（删帖确认，D84）与 `正文配图`（管理端 AI 配图上下文）各命中 1 次 → 前端这批确实上线；
  · prod `review_events` 10 行（迁移 0062 的 `issue_id` 尚未上线——那是 D82 的活，两个 agent 已在做）。
- 本轮上线：D78 讨论帖无反馈区、D79 正文恢复（+0061）、D80 编辑稿触发 AI 审核（+0060）、D81 审核后前端失效、D83/D84 两类错误设计的遗毒清理、G3 两条真缺陷（AI 放行补排 `search:index`、举报复核改判线上正文）。
- 回滚：`pg_restore --clean --if-exists -d <dsn> …/pre-deploy-b2f9de1-*.dump` + `current → 8b0b332`。


### 1s-production-2. 第十五轮第二批上生产（2026-10-16 13:5x；dev `c969416` → prod `d95df82`）

- **dev**：`c969416`，迁移 61→**62**（0062 issue 归档），health 200、bin/web 一致；备份 `pre-deploy-c969416-20261016-055309.dump`。
- **prod**：`b2f9de1 → d95df82`（163s），迁移 61→**62**；备份 `pre-deploy-d95df82-20261016-055736.dump`（263218 B）；health 200、公网 / 200 即本构建。
- **后验（只读，prod）**：`post_issues.archived_at` 与 `review_events.issue_id` 列在、`ck_reports_target_type` 含 **issue**、`/admin/issues` 未登 **401**、`/issues` 200、`floor=1 且被软删` 仍为 **0**、新文案进产物（登录设备 ×3 / 拉黑 ×5 / Issue 管理 ×2）、部署以来 journalctl **ERROR=0**。
- 本轮上线：D82（issue 可举报 → AI 审核 → 归档 + 管理后台「Issue 管理」屏）、D86（中文昵称 500）、D87（注册限流失败/成功分开算）、D88 首批 10 条补接线、D85（接线检查器按需 + 写进 §13.3）。
- **一条验证边界（如实记）**：dev 的验证码模式是 `always`（配置项，有意的产品配置），所以**dev 上没法免验证码做注册烟测**；昵称修复的端到端由两条红→绿用例覆盖——`auth/nickname_runes_test.go`（服务层，真实 ent + 真实 Postgres）与 `app/nickname_test.go`（**HTTP 层**：真实注册 7 个汉字并原样落库、21 个汉字断言 400）。
- 回滚：`pg_restore --clean --if-exists -d <dsn> …/pre-deploy-d95df82-*.dump` + `current → b2f9de1`。

---
## 2. 派发分组（互不重叠的文件作用域）

| 包 | 覆盖 | 主要文件 |
|---|---|---|
| **FIX-IMG** | D1 / D2 / D3 | `web/src/ui/rich/image-uploader.tsx`、`image-pipeline.ts`、`web/src/app/shell.tsx`（只读，报给 Lead）、`web/src/devroom/pages/03-navigation/**`、板块封面数据侧 |
| **FIX-TOPIC** | D4 / D5 / D6 / D7 / D8 / D9 | `web/src/devroom/pages/12-topic/**`、`13-issue/**`、`web/src/routes/{topic,issues}.tsx` |
| **FIX-MSG** | D10 / D11 | `web/src/devroom/pages/10-messages/**`、`19-search/**`、`web/src/routes/messages.tsx`、`web/src/ui/nav/**` |
| **FIX-ADMIN** | D12 / D13 / D14 / D15 | `web/src/devroom/pages/15-admin/**`、`web/src/routes/admin/**`、`web/src/ui/dev-entry.tsx`、`web/src/main.tsx` |

**Lead 专属**（子 agent 不许改，写进阻塞）：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`。
**每个包都必须遵守第 0 节的同源要求**，并且每条都要：先证明断言会红 → 改 View → DevRoom 出图 → 产品宿主跟着改 → 产品页出图对照。


---

## 1g. D25 / D28 / D29 的实测结论（FIX-PERM 2026-10-15）

| # | 结论 | 证据落点 |
|---|---|---|
| **D25②** ⛔**已被 D33③ 推翻（2026-10-15）** | 当时的实测结论是**图片不发**（下行是它的取证，留着当历史）；用户 2026-10-15 拍板**真做多模态**，现在配图会随审核请求发给模型（每帖 ≤4 张、单张 ≤2 MiB，超了截断并计数；判据 `forum/internal/aireview/aireview_test.go` 的 `TestOutboundPayloadCarriesImageBlocks` 与 `TestOutboundPayloadHasNoImageBlockWithoutImages`）。原结论：上行 payload 只有两段纯文本：system = 提示词、user = `标题：<t>\n\n正文：<1 楼 Markdown 源>`。图片**唯一的痕迹**是正文里的 `![alt](/img/<hash>)` 字面量——模型看不到图，审核员看到的也只是这行字。代码侧同源：`aireview/sql.go` 的 `sqlSubject` 只取 `topics.title` + `posts(floor=1).content_md`，**不 JOIN `topic_images`**；`platform/ai/ai.go` 的 `Judge` 只组 system + user 两条消息，没有任何多模态字段。 | 用例 `forum/internal/aireview/aireview_test.go` 的 `TestOutboundPayloadHasNoImageField`（逐字钉住 user 文本 + 断言两段里没有 `image_url`/`data:image`）；顺带修了这条用例逼出来的真缺陷：模型按 schema 省略非必填的 `categories` 时 `ai.parse` 返回 nil → 写 `review_events.categories`（`NOT NULL`）撞 23502，判定落不了库还反复重试 |
| **D25①** | ✅ 已做：审核屏右栏就地预览**正文全文**（不是 200 字摘要）+ 作者（昵称/@handle）+ 来源徽标；图片以 Markdown 原文可见；超上限必显示「已截断」。 | `forum/internal/forum/review_queue.go` 的 `body_md`/`body_truncated`（草稿档取 `rv.pending_md`）；`web/src/devroom/pages/15-admin/screens/review.tsx` 的 `review-preview-body`；图 `shots/fixperm/d25-review-preview.png` |
| **D28** | ✅ 已核：**只有一处偏差** —— `admin` 少 `resource.publish`（0017 种 16 个点，拍板 §1.3 要 17 个；那条迁移的注释自己写的就是 17）。后果不是「少一个勾」：管理员发 `kind=resource` 的帖子会被 403。`creator` 多出的 `topic.lock`/`topic.move` 是 d2-auth §8.6 的**明确取舍**，不是错。 | 对照表 `完全重构/进行中/D28-默认权限矩阵对照表.md`；迁移 `0052_admin_resource_publish`；判据 `forum/internal/app/role_permissions_test.go` |
| **D29** | ✅ 已做：`auth.registration.auto_activate` 成为**唯一真源**（配置值只在站点设置读不到时兜底），注册 / `/me` 回执 / 重发三条路联动；管理端补上**唯一的激活入口**（用户屏「危险动作 → 激活账号」，只写 `activated_at`）；注册页在关掉开关时落「等待管理员激活」而不是「请输入验证码」。 | 用例 `forum/internal/auth/activation_switch_test.go` 四条（先红后绿）；图 `shots/fixperm/d29-users-tall-selected.png` |

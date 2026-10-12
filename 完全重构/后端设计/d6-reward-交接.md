# D6 交接单（reward · report · site · mail）

> 上游：`d6-reward.md`（设计本体）。本文件只写**接线需要的东西**：对外接口签名、依赖别人的什么、未决问题、必须回写旧文档的矛盾。
> 适用范围：`internal/reward`、`internal/report`、`internal/site`、`internal/mail`、`internal/platform/mail`（provider + Router + 加解密 + 模板）、`internal/platform/audit`（审计写入口）。

---

## 1. 交付物与写作用域

| 交付 | 内容 |
|---|---|
| 新增 ent schema（13 个文件） | `schema/donation_record.go`、`user_donation_setting.go`、`donation_notice_default.go`、`report.go`、`site_setting.go`、`site_domain.go`、`announcement.go`、`banner.go`、`banner_role.go`、`banner_dismissal.go`、`mail_account.go`、`mail_quota.go`、`mail_log.go` |
| 手写迁移 | 上表全部 CHECK、部分索引、`uq_banner_dismissals_user`、`uq_mail_logs_idem`、三张自然主键的 PRIMARY KEY、全部 `DEFAULT now()`（§3.3 的清单） |
| 新包 | `internal/platform/audit`（Writer）、`internal/platform/mail`（mail.go / crypto.go / router.go / resend/ / smtp/） |
| 新模块 | `internal/reward`、`internal/report`、`internal/site`、`internal/mail`（每个按 v2 §3.1 的 service/handler/dto/tasks/deps/errors 结构） |
| 模板 | `internal/mail/templates/`（每模板一对 `.html.tmpl` / `.txt.tmpl`） |
| 不动 | 本域不改 `internal/ent/schema/` 里别人的文件（只在对方文件加一行反向边，由对方施工者改）；不动 `migrations/` 里已提交的文件 |

**13 张表**（不是 14）：donation_records、user_donation_settings、donation_notice_defaults、reports、site_settings、site_domains、announcements、banners、banner_roles、banner_dismissals、mail_accounts、mail_quota、mail_logs。

---

## 2. 对外暴露的 Go 接口签名

（完整版见设计文档 §5；这里是**接线时会被别人看到**的那部分。）

### 2.1 app 层要创建的东西

    // internal/app/infra.go 增补
    auditW  := audit.NewWriter(in.DB)
    crypter, err := pgmail.NewCrypter(cfg.Mail.KeyHex, cfg.Mail.OldKeyHex)  // err → 启动失败
    if err != nil { in.Close(); return nil, fmt.Errorf("mail crypter: %w", err) }
    mailRouter := pgmail.NewRouter(in.DB, crypter, resend.NewFactory()+smtp.NewFactory() /* 合成一个 Factory */,
                                   in.Clock, in.Log, cfg.Mail.CacheTTL)
    in.Audit, in.Mail = auditW, mailRouter

    // internal/app/modules.go 增补
    m.Site   = site.NewService(in.DB, cfg.Site, in.MD, in.Audit, in.Clock, in.Log)
    m.Mail   = mail.NewService(in.DB, in.Mail, in.Crypter, cfg.Mail, in.Queue, in.Clock, in.Log)
    m.Reward = reward.NewService(in.DB, in.Queue, m.User /*UserLookup*/, in.Audit, in.Clock, in.Log)
    m.Report = report.NewService(in.DB, m.Forum /*TargetResolver*/, in.Audit, in.Clock, in.Log)

    // internal/app/run.go 启动时（迁移校验之后、HTTP 之前）
    if err := m.Site.RegisterBaseDomain(ctx); err != nil { return err }   // 内部只 Warn，不返回致命错误
    // 启动自检（日志级，不阻塞）：
    //   有一把 mail 账号但 secret_cipher IS NULL        → Warn
    //   0 个 enabled 的 mail 账号                       → Warn（拍板：只 Warn）
    //   本域任何 mail_accounts 的 reset_tz 不在 pg_timezone_names → Error（见设计 §3.2 的检查 SQL）

    // internal/app/worker.go 注册
    in.Worker.Handle(queue.TypeMailSend, m.Mail.HandleMailSend)

### 2.2 别的模块会调本域的（本域提供的）

    // internal/mail —— 业务模块投递邮件的唯一入口
    type EnqueueInput struct {
        RecipientID    int64
        ToAddress      string
        Template       string          // verify_email / reset_password / test / notice
        Payload        map[string]any  // 模板数据（Nickname、ActionURL、Code、ExpiresMinutes…）
        IdempotencyKey string          // 例如 verify:<user_id>:<token_id>
    }
    func (s *mail.Service) EnqueueTx(ctx context.Context, tx *ent.Tx, in EnqueueInput) error

    // internal/site —— 别的模块读站点开关的唯一入口（**不是**直接查表）
    func (s *site.Service) Setting(ctx context.Context, key string) string   // 见 §3「需要补充的导出」
    func (s *site.Service) RegisterBaseDomain(ctx context.Context) error

### 2.3 本域依赖别人的（对方要提供的）

    // internal/user 提供（reward 的 deps.go 里定义的 UserLookup）
    func (s *user.Service) IDByHandle(ctx context.Context, handle string) (int64, error)
    func (s *user.Service) Basic(ctx context.Context, userID int64) (user.Basic, error)
    //   Basic{ PublicID string; Handle, Nickname string; AvatarSmallHash string; Status string }

    // internal/forum 提供（report 的 deps.go 里定义的 TargetResolver）
    func (s *forum.Service) ResolveTarget(ctx context.Context, targetType, publicID string) (int64, bool, error)
    //   targetType ∈ {topic, post, user}；返回 (内部 id, 是否存在, error)

    // internal/platform/markdown 提供（site 的 deps.go 里定义的 Markdown）
    func (r *markdown.Renderer) Render(md string) (string, error)

    // config：cfg.Mail 需要三个 getter（KeyHex / OldKeysHex / CacheTTL）；cfg.Site 需要 BaseURL / Debug
    //   —— 现有 config.Mail 已有 KeyHex / OldKeyHex 两个字段，只加 Getter 方法（或直接传子结构体）

### 2.4 反向边（要别人在他自己的 schema 文件里加一行）

| 文件 | 加什么 |
|---|---|
| `schema/user.go` | `edge.To("donation_setting", UserDonationSetting.Type).Unique()`、`edge.To("donations_sent", DonationRecord.Type)`、`edge.To("donations_received", DonationRecord.Type)`、`edge.To("donations_verified", DonationRecord.Type)`、`edge.To("reports_made", Report.Type)`、`edge.To("reports_handled", Report.Type)`、`edge.To("announcements", Announcement.Type)`、`edge.To("banners", Banner.Type)`、`edge.To("banner_dismissals", BannerDismissal.Type)` |
| `schema/role.go` | `edge.To("banner_roles", BannerRole.Type)` |
| `schema/topic.go` | `edge.To("donations", DonationRecord.Type)` |
| `schema/payment_channel.go` | `edge.To("donations", DonationRecord.Type)` |

**这几行是唯一会碰到别人文件的改动**，必须由对方模块的施工者做（施工计划 §0 第 2 条：一步一个写作用域）。

### 2.5 端点 → 权限点（回写 §21.2 用）

35 个端点见设计文档 §5.6 的表。权限点只用 `reward.verify` / `report.handle` / `site.setting` / `mail.manage`；用户侧端点全部不挂权限点（本人语义在 service 里判）。**必须新增的两类非权限判定**（route 上写不出来，只能在 service）：
- `/me/rewards` 只返回自己发出的；`/rewards/{id}` 的撤回只允许 donor 本人；
- `/users/{handle}/rewards` 与 `/users/{handle}/channels` 的公开性由对方用户的两个开关决定（设计 §6.4）。

---

## 3. 需要补充/明确的导出（写代码时会被卡住的三处）

1. `site.Service.Setting(ctx, key) string`：别的模块（auth 读 `registration.open`、forum 读 `post.review_policy`、reward 读 `donation.enabled`、mail 读 `mail.enabled`）**不直接查 site_settings 表**，统一走 site 的读接口 —— 这是「站点设置缓存只有一份」的前提。这里用**接口**而不是直接依赖 `*site.Service`，符合 v2 §4.2 第 3 条（各自 deps.go 定小接口，app 层注入）。
2. `queue.Task.RunAt` 的可用性：设计 §6.11 的「额度用尽 → 重排到明天」依赖处理函数能重新入队一条带 `RunAt` 的任务。v2 §7.4 的 `Task` 有 `RunAt`，但 `Queue` 接口只有 `Enqueue` / `EnqueueTx`（够用）。**需要 S1 的实现确实把 `RunAt` 落成 jobs.run_at**。
3. `audit.Writer.Write` 必须在 `tx` 里写：调用点全部在 `WithTx` 回调内。若某处确实没有事务（例如只读动作不可能有），那就**不写审计**（本域没有这种动作）。

---

## 4. 未决问题（每条给两种选择的代价）

| # | 未决 | 选择 A（推荐） | 选择 B |
|---|---|---|---|
| **U1** | `user_donation_settings.records_public` 的语义：是**打赏人**授权公开「这一笔」，还是**收款人**授权公开「我收到的」？ | **打赏人**（设计 §6.4 采用）：记录里有对方的身份与金额，公开与否由发起方定；代价是收款人不能单独把某一笔藏起来（他不喜欢的话只能找管理员） | **收款人**：收款人有权决定自己主页展示什么；代价是打赏人的身份与金额被单方面公开，隐私方向是反的 |
| **U2** | `site_domains` 要不要 `is_primary`（数据库文档 §4.9 有，本设计**删了**） | **删**：真源是配置的 `base_url`（Cookie/CSRF/CORS 都从它来），表里再存一个主域名就是第二真源；表只做「哪些域算自己」的白名单 | **留**：后台能显示「当前主域名」；代价是要写一条「主域名与 base_url 必须一致」的自检，否则两处必然漂移 |
| **U3** | `donation_records.channel_id` 要不要（§21.2 有、§12.2 没有、数据库文档的表没有这一列） | **要**（本设计加了）：核验时管理员知道对方扫的是哪张码；多码作者能自查；代价是 3 个 FK 索引里的一个 | **不要**：少一列；代价是核验页只能显示所有收款码，多码作者无法定位 |
| **U4** | 能不能举报**自己**的内容 | **不能**（400）：自己举报自己只会给队列制造噪音；要删自己的帖子有编辑/删除 | **能**：有人真的会用它通知管理员；代价是队列里混入可自行处理的行 |
| **U5** | 重复举报返回 200 还是 409 | **200 + 既有行**（设计 §6.5）：幂等，连点不报错；代价是前端无法区分「新建」与「已存在」（响应里可以带 `created: false`） | **409 `report.duplicate`**：语义直白；代价是双击举报弹一个错误，而用户的目的已经达成 |
| **U6** | 未知 setting key 用 `site.unknown_setting` 还是 `common.invalid_input` | **common.invalid_input + fields**（少一个错误码）：前端已有 `fields` 的表单错误处理 | **`site.unknown_setting`**：能单独统计「客户端在写老 key」；代价是多一个码、前端要多一条映射 |
| **U7** | 批量核验/处理用「一个事务 + 逐条 CAS」还是「逐条独立事务」 | **一个事务**（设计 §6.3）：一个管理员意图 = 一个事务，不占满 16 条连接；结果是逐条成败 | **逐条事务**：一条失败绝不影响别的；代价是 N 次事务开销 + N 条连接占用，且失败点更多 |
| **U8** | `mail_logs` 的保留期（清理任务） | **暂不清理**（设计 §12）：`(status, created_at DESC)` 索引够用，量级是「注册/找回密码 + 通知」 | **保留 90 天**：要新增一个 `queue:cleanup` 的清理项 + 一条 `created_at` 部分索引；代价是多一个后台任务 |
| **U9** | `POST /api/v1/markdown/preview` 归 site 还是 forum | **site**（本设计）：站点级内容工具，与 `/site` 同族；代价是 site 依赖 `platform/markdown` | **forum**：渲染逻辑本来就在 forum；代价是 site 的公告也要用同一份渲染（那就得依赖 forum 或 platform，绕一圈） |
| **U10** | 横幅定向的 `banner_roles` 用「有行 = 定向，无行 = 所有人」还是加一个 `target_all bool` | **无行 = 所有人**（旧站 banner_groups 同款）：没有第二个真源；代价是「给所有角色各加一行」与「一行不加」语义不同，后台要提示 | **显式 `target_all`**：意图更清楚；代价是多一列 + 「target_all=true 且又有行」的非法状态要挡 |

**我不打算自己拍板的**：U1、U4、U6（都是产品/契约口味问题，代价已列出）；其余我给推荐并在设计里按推荐写。

---

## 5. 旧文档矛盾（我按拍板/缺省处理了，必须回写）

| # | 矛盾 | 出处 | 本设计怎么处理 |
|---|---|---|---|
| 1 | `reports` 的列名：拍板写 `state`/`handler_id`/`handled_at`/`handle_note`，数据库文档 §4.3 写 `status`/`handled_by`/`handled_at` 且没有 `public_id`/`detail` | 拍板 §4.1 vs 数据库文档 §4.3 | **以拍板为准**，并补 `public_id`（盲审 M6：`{id}` 端点不能用自增 id）与 `detail`（界面需求已做 reason+detail 两栏） |
| 2 | `reports` 处理端点：§21.2 是 `PATCH /api/v1/admin/reports/{id}`，界面需求 §5.7 写 `POST /api/v1/admin/topics/{id}/review`（那是审核，不是举报） | v2 §21.2 / 界面需求 §5.11 | **PATCH**（与批量 POST 区分） |
| 3 | `POST /api/v1/rewards` 的 body：§12.2 有 `txn_id` 无 `channel_id`，§21.2 有 `channel_id` 无 `txn_id` | v2 §12.2 vs §21.2 | **两个都要**（数据库文档的表也缺 `channel_id`，见 U3） |
| 4 | `user_donation_settings` 的列在全套文档里从未定义（§4.6 说「两个展示开关」，§12.2 说三个开关 + 文案） | 数据库文档 §4.6 / v2 §12.2 | **三个开关 + 文案**（§12.2 与旧站 12.2/12.3/12.6 一致），列清单写进设计 §3.2 |
| 5 | `donation_records.post_id` 指向 `topics`（不是 posts） | 数据库文档 §4.6 | 显式写成 `REFERENCES topics(id)`，并在 §6.1 第 5 条要求 `author_id = recipient_id` |
| 6 | 数据库文档 §4.9 的 `banners` 索引是 `(starts_at, ends_at) WHERE enabled`，但查询要用 `now()` 双端判断 | 数据库文档 §4.9 | 保留该索引，谓词与查询逐字对齐（设计 §7.10）；**没有加 `ends_at IS NULL` 的部分谓词**，因为 null 行也要进索引 |
| 7 | 盲审 M6 要求 `{id}` 端点对应的表有 `public_id` `public_id`（M6）而数据库文档没写 | 盲审 M6 | 本域所有 `{id}` 端点对应的表都补 `public_id`：reports / banners / announcements / mail_accounts / donation_records |
| 8 | 拍板 §5.4 要求 site_settings 缓存，但没说缓存粒度与失效方式 | 拍板 §5.4 | 定成「进程内整表 + 30 秒 TTL + 写后 Invalidate」（设计 §8.1） |
| 9 | v2 §7.4 的任务类型常量表里有 `TypeRewardReconcile = "reward:reconcile"` | v2 §7.4（第 2 章与盲审 C2 已判定：对账属于已删除的支付路线） | **本域不用它**，也不删常量（那是 queue 包的事）；回写 §7.4 时应删掉这一行 |
| 10 | `donation_records` 的索引在拍板里写作 `(recipient_id, state, ...)`，没有 `id` 兜底 | 拍板 §4.1 | 补 `id DESC`（拍板 §5.1 要求排序键永远带 id 兜底）；`(state, created_at DESC)` 同样补 |

---

## 6. 实现顺序建议（S7 内可并行，按施工计划 §3 的写作用域）

1. **先做** `platform/audit` + 13 张表的 schema/迁移（其他三者都依赖它；这一步不碰别人文件，除了 §2.4 的反向边）；
2. 然后三条互不重叠的线：
   - `internal/mail` + `platform/mail`（凭据加密 → Router 额度 → mail:send 任务 → 模板 → 后台 CRUD）；
   - `internal/reward` + `internal/report`（两者都是「CAS + 审计 + 游标队列」，可以先写 reward，report 抄结构）；
   - `internal/site`（设置缓存 → 公告横幅 → 域名登记）；
3. 最后接 app 层（infra/modules/http/worker 四处）与契约测试的端点清单。

**验收线**（对应 v2 M3/M7 与设计 §10）：同一 MailLog 重试 3 次只占 1 次额度；主密钥不对启动直接失败；赞赏只有三条转换；统计只算 approved 且双方公开；重复核验 409 且审计只有一条；驳回后能再举报；未知 setting key 400 且不写库；横幅关得掉。

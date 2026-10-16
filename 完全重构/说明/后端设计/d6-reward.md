# D6 赞赏 / 举报 / 运营 后端设计（reward · report · site · mail）

> 依据（冲突时按此顺序）：`后端开工前拍板.md` > `开发必读.md` > `数据库设计-postgresql.md` §2/§3/§4 > `论坛后端技术方案-v2.md` §3/§4/§8/§12/§14/§21 > `RBAC权限树设计.md`。
> 本文是这四个模块的**实现级设计**：表、ent schema、Go 接口、真实 SQL、状态机、错误码、测试清单。
> 权限点一律用拍板 §1.2 的 23 个（本域只涉及 `reward.verify` / `report.handle` / `site.setting` / `mail.manage` / `audit.view` / `audit.export`）。
> **本域没有支付 Gateway / 回调 / 对账 / Wallet / LedgerEntry / 余额**（拍板 §6 定案）；也不做「已支付 / 已结算 / 已退款」。

---

## 0. 范围与模块归属

| 模块 | 拥有的表 | 负责 |
|---|---|---|
| `internal/reward` | donation_records / user_donation_settings / donation_notice_defaults | 申报、撤回、核验、统计 |
| `internal/report` | reports | 举报提交 + 处理队列 |
| `internal/site` | site_settings / site_domains / announcements / banners / banner_roles / banner_dismissals | 站点键值、公告、横幅、域名登记、markdown 预览 |
| `internal/mail` | mail_accounts / mail_quota / mail_logs | 账号 CRUD（凭据加密）、`mail:send` 任务、模板、额度账 |
| `internal/platform/mail` | —（无表） | provider 接口、Router（轮询 + 额度占用）、chacha20poly1305 加解密、模板 embed |
| `internal/platform/audit` | audit_logs（表由 RBAC 域建） | `Writer.Write(ctx, tx, Entry)`：本域唯一的审计写入口 |
| `internal/platform/idgen` | — | `NewPublicID()`（UUID v7）、`ParsePublicID(s string) (int64, error)`（拍板 §5.6） |

**表数量：13 张，全部新建**（没有一个复用现有表）。清单见 §3.1。

**平台侧与业务侧的分界（本域最容易写错的一处）**

- `platform/mail` 允许 import `internal/ent`（v2 §4.2 第 2 条），所以 Router 直接读写 mail_accounts / mail_quota 合规；它**不能** import `internal/mail`。
- `mail:send` 的处理器放在 `internal/mail/tasks.go`（业务模块结构约定：tasks.go 属业务模块），它调 `platform/mail.Router`；反过来不成立，所以没有环。
- 任务类型常量在 `platform/queue/types.go`（拍板 §5.7 一处定义）：本域复用已有的 `mail:send` 与 `notify:reward`，**不新增任务类型**。
- 审计写入口收在 `platform/audit`：否则「actor/target/detail 怎么填」会被四个模块各写一遍（复盘根因 2）。

---

## 1. 权限点与审计

本域用到的权限点（**不新增权限点**）：

| key | 用在哪 |
|---|---|
| `reward.verify` | `/api/v1/admin/rewards*`（核验、改判、批量、统计） |
| `report.handle` | `/api/v1/admin/reports*` |
| `site.setting` | `/admin/site-settings`、`/admin/announcements*`、`/admin/banners*`、`/admin/site-domains`、`/admin/diagnostics` |
| `mail.manage` | `/api/v1/admin/mail/accounts*` |
| `audit.view` / `audit.export` | `/admin/audit-logs`、`/admin/audit-logs/export`（端点归属模块由 Lead 定，见交接单「待接线」） |

`/api/v1/markdown/preview` 按**放在 `internal/site`** 设计（站点级内容，与 `site.setting` 同族）。这是**未决问题 U9**；若 Lead 判它属于 forum，把 handler 搬过去即可（实现体是 `platform/markdown` 的薄封装，不动表）。

### 1.1 audit_logs 写入点清单（逐条）

`target_type` 用字符串（列是 `varchar(32)`），`target_id` 一律是**对外 id**（public_id / key）：审计页会被导出，自增 id 不许出现在任何对外位置（拍板 §5.6）。`detail` 统一写 `{"before": {...}, "after": {...}}`。

| # | action | target_type | target_id | 触发点 | detail | actor |
|---|---|---|---|---|---|---|
| 1 | `reward.verify` | `reward` | donation_records.public_id | 核验 approved/rejected（含改判） | state、amount_cents、note | 管理员 |
| 2 | `reward.withdraw` | `reward` | 同上 | 用户撤回自己 pending 的申报 | state: pending → withdrawn | 申报人本人 |
| 3 | `report.handle` | `report` | reports.public_id | 处理 / 驳回 / 批量处理 | state、handle_note | 管理员 |
| 4 | `site.setting.update` | `site` | **setting key 本身**（一 key 一行审计） | `PATCH /admin/site-settings` | value（单 key 的 before/after） | 管理员 |
| 5 | `announcement.create` / `announcement.update` | `announcement` | announcements.public_id | 建 / 改 / 上下线公告 | title、enabled、published_at | 管理员 |
| 6 | `banner.create` / `banner.update` | `banner` | banners.public_id | 建 / 改 / 启停 / 改定向 | kind、enabled、starts_at、ends_at、roles | 管理员 |
| 7 | `mail.account.create` | `mail_account` | mail_accounts.public_id | 新建发信账号 | name、provider、priority、daily_limit、enabled、secret_configured | 管理员 |
| 8 | `mail.account.update` | `mail_account` | 同上 | 改优先级 / 额度 / 发件人 / 开关 / **换凭据** | 变更字段；凭据只写 secret_updated_at（**永不写凭据本身**） | 管理员 |
| 9 | `mail.account.archive` | `mail_account` | 同上 | 删除（有 mail_logs 引用时降级为归档） | archived_at | 管理员 |

**不写审计的**（写下来是为了以后不要再讨论）：

- `report.create`（用户举报）：举报本身是用户行为，reports 表就是留痕；
- 站点设置的**读**、横幅 dismiss、公告读、预览渲染；
- 邮件发送成功/失败：mail_logs 是它的账；写进审计会把审计表变成日志表（量级差三个数量级）；
- `mail.account.test`（测试发信）：它有 mail_logs，能查到。

**事务纪律**：审计行必须与业务行**同一个事务**（`audit.Write(ctx, tx, ...)`），否则会出现「核验成功但审计丢失」，而审计是追责的唯一途径。IP 由 handler 从 `c.ClientIP()` 放进 Input —— service 不碰 gin（v2 §4.2 第 6 条）。

---

## 2. 状态机（先定这个，SQL 才有意义）

### 2.1 donation_records

    新增:  ──────────────────────────► pending
    pending  ──(admin reward.verify, state=approved)──► approved
    pending  ──(admin reward.verify, state=rejected)──► rejected
    pending  ──(donor DELETE /rewards/{id})──────────► withdrawn
    approved/rejected ──(admin 改判)──► 另一态        ← 两个方向都允许
    withdrawn ──✗──► 任何态                            ← 终态；核验它 → 409 reward.invalid_transition

核验端点的判定顺序：

    1. authz.Require(actor, reward.verify)        —— service 层兜底（队列/CLI 也走这里）
    2. 按 public_id 读行；不存在 → 404 common.not_found
    3. state = 'withdrawn'                       → 409 reward.invalid_transition
    4. state 已经是目标态                         → 409 reward.already_handled
    5. 条件 UPDATE（CAS，§7.2）                   → RowsAffected = 0 → 409 reward.already_handled
    6. 同一事务写 audit_logs（action=reward.verify）
    7. 同一事务 EnqueueTx(notify:reward, {id:<donation_id>})  通知收款人

**为什么第 4 步和第 5 步都要**：第 4 步给「两个管理员同时点」一个确定的 409 而不是随机结果；第 5 步才是真正的并发保证（第 4 步读到 pending、第 5 步写时对方已经成功）。只留第 5 步也对，但常见路径要多一次回查；只留第 4 步是错的（盲审 M4：核验必须用条件更新）。

### 2.2 reports

    open ──(report.handle, state=handled)──► handled
    open ──(report.handle, state=dismissed)─► dismissed
    handled/dismissed ──✗──► 任何态      ← 终态（举报不是工单，不做重开；要重开再报一次，uq_reports_once 允许）

判定顺序与 2.1 同构：Require → 读行 → 终态判断（409 `report.already_handled`）→ CAS → 审计。

### 2.3 site_settings

无状态机。唯一写入口是 `PATCH /admin/site-settings`，键必须在代码表（§5.4）里，否则 400 —— **禁止静默写入**。

### 2.4 mail_logs

    pending ──(发送成功)────────────────────────► sent    ← 终态；重复执行任务直接返回 nil
    pending ──(ErrPermanent / mail.enabled=off)─► failed（dead，不重试）
    pending ──(ErrTemporary / ErrNoProvider)────► pending（队列退避重试；后者重排到明天）

### 2.5 一次投递的状态（额度占用的粒度）

    收到投递请求（MailLog 的 id）
      ├─ mail_logs.status = 'sent' → 直接返回成功（幂等）
      ├─ 渲染模板（失败 = 代码 bug → failed + ErrSkipRetry）
      └─ 选账号：Router.Acquire
           ├─ 已占额度且 quota_day = 该账号今天的自然日 → **复用**该账号，不再 +1
           ├─ 已占额度但 quota_day < 今天            → 视为未占，重新 Acquire
           └─ 未占 → 挑 priority 最大的可用账号，原子占额度，写回 MailLog(quota_account_id, quota_day)
         发送结果：
           ErrQuotaExceeded → 熔断该账号（内存，key = name + day）→ 换下一个账号
           ErrTemporary     → 记 last_error → 换下一个账号
           ErrPermanent     → 不换账号；MailLog = failed；返回 queue.ErrSkipRetry
           ErrNoProvider    → 全部没额度 → 重排到下一个 reset（§6.11）

**「一次投递」的落点**：额度只在 `Acquire` 里 +1，MailLog 的 `quota_day` 记住是哪天占的；重试先看 `quota_day`，所以「同一 MailLog 重试 3 次只占 1 次额度」。

---

## 3. 数据表

### 3.1 表清单（13 张，全部新建）

| # | 表 | 用途 | 主键 | 关键索引 |
|---|---|---|---|---|
| 1 | donation_records | 赞赏申报单 | id identity | `(state, created_at DESC, id DESC)`、`(recipient_id, state, created_at DESC, id DESC)`、`(donor_id, created_at DESC, id DESC)` |
| 2 | user_donation_settings | 三开关 + 文案 | user_id | — |
| 3 | donation_notice_defaults | 按渠道默认文案 | channel | — |
| 4 | reports | 举报 | id identity | uq_reports_once（部分唯一）、`(state, created_at DESC, id DESC)` |
| 5 | site_settings | 站点键值 | key | — |
| 6 | site_domains | 域名白名单 | domain | — |
| 7 | announcements | 公告 | id identity | `(published_at DESC, id DESC) WHERE enabled AND published_at IS NOT NULL` |
| 8 | banners | 顶部横幅 | id identity | `(starts_at, ends_at) WHERE enabled` |
| 9 | banner_roles | 横幅按角色定向 | (banner_id, role_id) | `idx_banner_roles_role (role_id)` |
| 10 | banner_dismissals | 「不再显示」 | (banner_id, user_id) | `uq_banner_dismissals_user (user_id, banner_id)` |
| 11 | mail_accounts | 发信账号（凭据加密） | id identity | uq_mail_accounts_name |
| 12 | mail_quota | 每日额度账 | (account_id, day) | —（PK 覆盖） |
| 13 | mail_logs | 每封邮件一条 | id identity | uq_mail_logs_idem、`(status, created_at DESC)`、`idx_mail_logs_quota_account` |

全表共同约定（数据库文档 §2）：`id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`；对外 id = `public_id uuid NOT NULL UNIQUE`（应用用 v7 生成，**DDL 不给默认值**）；时间 `timestamptz`；金额 `bigint`（分）；枚举 `text + CHECK`；每表有 `created_at`，会变的表有 `updated_at`（由 ent mixin 在应用层写）。

**本域依赖、但不由本域建的表**（只写引用到的列）：

    images(hash varchar(64) PK, visibility smallint CHECK (visibility IN (0,1,2)), refcount int, owner_id bigint)
    users(id bigint PK, public_id uuid NOT NULL UNIQUE, status text, role_id bigint NOT NULL)
    topics(id bigint PK, public_id uuid, author_id bigint, status text)
    payment_channels(id bigint PK, user_id bigint, label varchar(32), image_hash varchar(64), sort int)
    roles(id bigint PK, key varchar(32) UNIQUE)

### 3.2 DDL（可直接执行；`-- [手写]` 标记的是 ent 生成不了、必须留在手写迁移里的对象）

    -- ============================================================
    -- 1) donation_records
    -- ============================================================
    CREATE TABLE donation_records (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id     uuid         NOT NULL UNIQUE,
      donor_id      bigint       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      recipient_id  bigint       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount_cents  bigint       NOT NULL,
      txn_id        varchar(64)  NOT NULL DEFAULT '',
      post_id       bigint       NULL REFERENCES topics(id) ON DELETE SET NULL,
      channel_id    bigint       NULL REFERENCES payment_channels(id) ON DELETE SET NULL,
      state         text         NOT NULL DEFAULT 'pending',
      note          varchar(200) NOT NULL DEFAULT '',
      verified_by   bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
      verified_at   timestamptz  NULL,
      created_at    timestamptz  NOT NULL DEFAULT now(),
      updated_at    timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT ck_donation_records_amount   CHECK (amount_cents > 0),
      CONSTRAINT ck_donation_records_not_self CHECK (donor_id <> recipient_id),
      CONSTRAINT ck_donation_records_state    CHECK (state IN ('pending','approved','rejected','withdrawn')),
      CONSTRAINT ck_donation_records_verified CHECK (
        (state IN ('pending','withdrawn') AND verified_by IS NULL     AND verified_at IS NULL) OR
        (state IN ('approved','rejected') AND verified_by IS NOT NULL AND verified_at IS NOT NULL))
    );

    -- [手写] 核验队列（游标分页；列序 = 排序键序）
    CREATE INDEX idx_donation_records_queue
      ON donation_records (state, created_at DESC, id DESC);
    -- [手写] 收入侧：主页/统计按收款人扫 approved
    CREATE INDEX idx_donation_records_recipient
      ON donation_records (recipient_id, state, created_at DESC, id DESC);
    -- [手写] 支出侧：我发出的申报（不过滤 state）
    CREATE INDEX idx_donation_records_donor
      ON donation_records (donor_id, created_at DESC, id DESC);
    -- 外键索引（PG 不自动建；数据库文档 §12 第 1 条会检查）
    CREATE INDEX idx_donation_records_post     ON donation_records (post_id);
    CREATE INDEX idx_donation_records_channel  ON donation_records (channel_id);
    CREATE INDEX idx_donation_records_verifier ON donation_records (verified_by);

    -- ============================================================
    -- 2) user_donation_settings（一行一人；三个开关 + 文案）
    -- ============================================================
    CREATE TABLE user_donation_settings (
      user_id        bigint       PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      show_channels  boolean      NOT NULL DEFAULT false,  -- 展示收款码（旧站默认关）
      records_public boolean      NOT NULL DEFAULT false,  -- 我的打赏记录可公开（旧站默认关）
      notice_visible boolean      NOT NULL DEFAULT true,   -- 显示打赏提示文案
      notice_text    varchar(200) NOT NULL DEFAULT '',     -- 空 = 用 donation_notice_defaults
      created_at     timestamptz  NOT NULL DEFAULT now(),
      updated_at     timestamptz  NOT NULL DEFAULT now()
    );

    -- ============================================================
    -- 3) donation_notice_defaults（按渠道的默认提示文案）
    -- ============================================================
    CREATE TABLE donation_notice_defaults (
      channel    text         PRIMARY KEY,
      text       varchar(200) NOT NULL DEFAULT '',
      created_at timestamptz  NOT NULL DEFAULT now(),
      updated_at timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT ck_donation_notice_defaults_channel
        CHECK (channel IN ('default','wechat','alipay','other'))
    );

    -- ============================================================
    -- 4) reports
    -- ============================================================
    CREATE TABLE reports (
      id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id   uuid          NOT NULL UNIQUE,
      target_type text          NOT NULL,
      target_id   bigint        NOT NULL,          -- 多态，无外键（数据库文档 §4.3 已记账）
      reason      varchar(500)  NOT NULL,
      detail      varchar(1000) NOT NULL DEFAULT '',
      reporter_id bigint        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      state       text          NOT NULL DEFAULT 'open',
      handler_id  bigint        NULL REFERENCES users(id) ON DELETE SET NULL,
      handled_at  timestamptz   NULL,
      handle_note varchar(500)  NOT NULL DEFAULT '',
      created_at  timestamptz   NOT NULL DEFAULT now(),
      updated_at  timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT ck_reports_target_type CHECK (target_type IN ('topic','post','user')),
      CONSTRAINT ck_reports_state       CHECK (state IN ('open','handled','dismissed')),
      CONSTRAINT ck_reports_handled     CHECK (
        (state = 'open' AND handler_id IS NULL     AND handled_at IS NULL) OR
        (state IN ('handled','dismissed') AND handler_id IS NOT NULL AND handled_at IS NOT NULL))
    );

    -- [手写] 部分唯一索引：同一人对同一对象最多留一条**未处理**的举报。
    CREATE UNIQUE INDEX uq_reports_once
      ON reports (reporter_id, target_type, target_id) WHERE state = 'open';
    -- [手写] 处理队列（与游标排序同序）
    CREATE INDEX idx_reports_queue    ON reports (state, created_at DESC, id DESC);
    -- [手写] 我发出的举报
    CREATE INDEX idx_reports_reporter ON reports (reporter_id, created_at DESC, id DESC);
    -- 外键索引 + 孤儿检查
    CREATE INDEX idx_reports_handler  ON reports (handler_id);
    CREATE INDEX idx_reports_target   ON reports (target_type, target_id);

    -- ============================================================
    -- 5) site_settings
    -- ============================================================
    CREATE TABLE site_settings (
      key        varchar(64) PRIMARY KEY,
      value      text        NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- 不预置任何行：缺 key = 用代码里的默认值（§5.4）。插空行会让「默认值」有两个真源。

    -- ============================================================
    -- 6) site_domains
    -- ============================================================
    CREATE TABLE site_domains (
      domain     varchar(253) PRIMARY KEY,   -- 统一存 lower() 形式，写入时归一化
      created_at timestamptz  NOT NULL DEFAULT now()
    );

    -- ============================================================
    -- 7) announcements
    -- ============================================================
    CREATE TABLE announcements (
      id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id    uuid         NOT NULL UNIQUE,
      title        varchar(120) NOT NULL,
      body_md      text         NOT NULL,
      body_html    text         NOT NULL,
      enabled      boolean      NOT NULL DEFAULT true,
      published_at timestamptz  NULL,        -- NULL = 草稿
      created_by   bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at   timestamptz  NOT NULL DEFAULT now(),
      updated_at   timestamptz  NOT NULL DEFAULT now()
    );
    -- [手写] 部分索引：只索引会出现在首页的公告（草稿不进索引）
    CREATE INDEX idx_announcements_published
      ON announcements (published_at DESC, id DESC)
      WHERE enabled AND published_at IS NOT NULL;
    CREATE INDEX idx_announcements_created_by ON announcements (created_by);

    -- ============================================================
    -- 8) banners
    -- ============================================================
    CREATE TABLE banners (
      id         bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id  uuid         NOT NULL UNIQUE,
      kind       text         NOT NULL,
      text       varchar(200) NOT NULL,
      url        text         NULL,
      starts_at  timestamptz  NOT NULL DEFAULT now(),
      ends_at    timestamptz  NULL,
      enabled    boolean      NOT NULL DEFAULT true,
      created_by bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz  NOT NULL DEFAULT now(),
      updated_at timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT ck_banners_kind   CHECK (kind IN ('info','warning','promo')),
      CONSTRAINT ck_banners_window CHECK (ends_at IS NULL OR ends_at > starts_at)
    );
    -- [手写] 部分索引：谓词必须与查询逐字一致才用得上
    CREATE INDEX idx_banners_active ON banners (starts_at, ends_at) WHERE enabled;
    CREATE INDEX idx_banners_created_by ON banners (created_by);

    -- ============================================================
    -- 9) banner_roles（拍板：横幅定向用**角色**，不用用户组）
    -- ============================================================
    CREATE TABLE banner_roles (
      banner_id bigint NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
      role_id   bigint NOT NULL REFERENCES roles(id)   ON DELETE CASCADE,
      PRIMARY KEY (banner_id, role_id)
    );
    -- 复合主键的第二列不算「已索引」（数据库文档 §12 第 1 条），级联删除路径要补单列索引
    CREATE INDEX idx_banner_roles_role ON banner_roles (role_id);

    -- ============================================================
    -- 10) banner_dismissals
    -- ============================================================
    CREATE TABLE banner_dismissals (
      banner_id  bigint      NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
      user_id    bigint      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (banner_id, user_id)
    );
    -- [手写] 「我关过哪些横幅」要按 (user_id, banner_id) 反查 → 必须有这个方向的索引
    CREATE UNIQUE INDEX uq_banner_dismissals_user ON banner_dismissals (user_id, banner_id);

    -- ============================================================
    -- 11) mail_accounts
    -- ============================================================
    CREATE TABLE mail_accounts (
      id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id         uuid         NOT NULL UNIQUE,
      name              varchar(64)  NOT NULL UNIQUE,
      provider          text         NOT NULL,
      priority          int          NOT NULL DEFAULT 0,
      daily_limit       int          NOT NULL DEFAULT 100,
      reset_tz          varchar(64)  NOT NULL DEFAULT 'Asia/Shanghai',
      from_address      varchar(254) NOT NULL,
      from_name         varchar(64)  NOT NULL DEFAULT '',
      options_json      jsonb        NOT NULL DEFAULT '{}',
      secret_cipher     bytea        NULL,
      secret_nonce      bytea        NULL,
      secret_updated_at timestamptz  NULL,
      enabled           boolean      NOT NULL DEFAULT true,
      archived_at       timestamptz  NULL,
      last_ok_at        timestamptz  NULL,
      last_error        text         NULL,
      last_error_at     timestamptz  NULL,
      created_at        timestamptz  NOT NULL DEFAULT now(),
      updated_at        timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT ck_mail_accounts_provider CHECK (provider IN ('resend','smtp')),
      CONSTRAINT ck_mail_accounts_priority CHECK (priority >= 0),
      CONSTRAINT ck_mail_accounts_limit    CHECK (daily_limit > 0),
      CONSTRAINT ck_mail_accounts_secret_pair
        CHECK ((secret_cipher IS NULL) = (secret_nonce IS NULL))
    );
    -- reset_tz 是 IANA 名字，PG 自己知道全部合法值（迁移期自检，不是表约束）：
    --   SELECT a.name, a.reset_tz FROM mail_accounts a
    --    WHERE NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = a.reset_tz);
    --   有结果即失败（Go 侧 time.LoadLocation 也会失败，两处都会红）。

    -- ============================================================
    -- 12) mail_quota（每日额度账；必须持久化，禁止放内存）
    -- ============================================================
    CREATE TABLE mail_quota (
      account_id bigint      NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      day        date        NOT NULL,
      count      int         NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, day),
      CONSTRAINT ck_mail_quota_count CHECK (count >= 0)
    );
    -- account_id 是 PK 首列 → 外键级联路径已覆盖，无需额外索引

    -- ============================================================
    -- 13) mail_logs
    -- ============================================================
    CREATE TABLE mail_logs (
      id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      idempotency_key     varchar(128) NOT NULL,
      to_address          varchar(254) NOT NULL,
      template            varchar(64)  NOT NULL,
      payload             jsonb        NOT NULL DEFAULT '{}',
      status              text         NOT NULL DEFAULT 'pending',
      provider            varchar(32)  NOT NULL DEFAULT '',
      provider_message_id text         NULL,
      error               text         NULL,
      attempts            int          NOT NULL DEFAULT 0,
      quota_account_id    bigint       NULL REFERENCES mail_accounts(id) ON DELETE SET NULL,
      quota_day           date         NULL,
      sent_at             timestamptz  NULL,
      created_at          timestamptz  NOT NULL DEFAULT now(),
      updated_at          timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT ck_mail_logs_status   CHECK (status IN ('pending','sent','failed')),
      CONSTRAINT ck_mail_logs_template CHECK (template IN ('verify_email','reset_password','test','notice')),
      CONSTRAINT ck_mail_logs_attempts CHECK (attempts >= 0)
    );
    -- [手写] 幂等键：NOT NULL + 唯一（可空的话 NULL 行不受约束，幂等静默失效）
    CREATE UNIQUE INDEX uq_mail_logs_idem ON mail_logs (idempotency_key);
    CREATE INDEX idx_mail_logs_status ON mail_logs (status, created_at DESC);
    -- 外键索引（PG 不自动建）
    CREATE INDEX idx_mail_logs_quota_account ON mail_logs (quota_account_id);

### 3.3 ent 生成不了、必须留在手写迁移里的对象（一次列清）

| 对象 | 为什么 ent 不行 |
|---|---|
| 全部 `ck_*` CHECK | 已核实：ent 的 `field.Enum` 在 PG 上只落 varchar、不生成 CHECK（数据库文档 §2.6） |
| `uq_reports_once` / `idx_banners_active` / `idx_announcements_published` | 部分索引；ent 只能用 `entsql.IndexWhere` **声明**，落地仍由迁移写 |
| `uq_banner_dismissals_user` | 列序与 PK 相反的额外唯一索引；`Index.Fields` 只能按声明顺序生成一个方向 |
| 全部 `DEFAULT now()`（created_at / updated_at） | ent 的 `.Default(time.Now)` 不写进 DDL，必须 `entsql.DefaultExpr("now()")` |
| `mail_quota.day` / `mail_logs.quota_day` 的 `date` 类型 | ent 要 `field.Time` + `SchemaType` 映射到 `date`，落 DDL 时必须核对不是 `timestamptz` |
| `donation_notice_defaults.channel` 的 CHECK | 无 id 主键的字符串表；`field.String().Unique()` 能表达唯一性，CHECK 不行 |
| 三张自然主键表（user_donation_settings / donation_notice_defaults / mail_quota）的 PRIMARY KEY | ent 里「非 id 主键」要在手写迁移里改（见 §4.9） |

**枚举值域的两份真源**：`state` / `target_type` / `kind` / `provider` / `status` / `template` 的值域在 **Go 常量**与 **CHECK** 里各写一次，由数据库文档 §12 第 4 条的自检比对，不一致即失败。`donation_notice_defaults.channel` 的 4 个值**不参与任何判定**（只用来取默认文案，未知值回落 `default` 行），所以**不进**自检名单 —— 写一条永远红的检查只会让人把检查关掉。

---

## 4. ent schema 设计

路径：`forum/internal/ent/schema/`。只列本域新增的文件；`users.go` / `roles.go` / `images.go` / `topics.go` / `payment_channels.go` 属别人，本域**只加反向边**（在对方文件里加一行，由对方模块的施工者做 —— 见交接单「依赖」）。

### 4.1 `schema/donation_record.go`

    func (DonationRecord) Mixin() []ent.Mixin { return []ent.Mixin{TimeMixin{}} }  // created_at + updated_at

    func (DonationRecord) Fields() []ent.Field {
        return []ent.Field{
            field.UUID("public_id", uuid.UUID{}).Unique().Immutable(),
            field.Int64("donor_id"),
            field.Int64("recipient_id"),
            field.Int64("amount_cents"),
            field.String("txn_id").MaxLen(64).Default(""),
            field.Int64("post_id").Optional().Nillable(),      // topics.id
            field.Int64("channel_id").Optional().Nillable(),   // payment_channels.id
            field.String("state").MaxLen(16).Default("pending"),
            field.String("note").MaxLen(200).Default(""),
            field.Int64("verified_by").Optional().Nillable(),
            field.Time("verified_at").Optional().Nillable(),
        }
    }

    func (DonationRecord) Edges() []ent.Edge {
        return []ent.Edge{
            edge.From("donor", User.Type).Ref("donations_sent").Field("donor_id").Required().Unique(),
            edge.From("recipient", User.Type).Ref("donations_received").Field("recipient_id").Required().Unique(),
            edge.From("verifier", User.Type).Ref("donations_verified").Field("verified_by").Unique(),
            edge.From("post", Topic.Type).Ref("donations").Field("post_id").Unique(),
            edge.From("channel", PaymentChannel.Type).Ref("donations").Field("channel_id").Unique(),
        }
    }

    func (DonationRecord) Indexes() []ent.Index {
        return []ent.Index{
            index.Fields("state", "created_at"),                 // 迁移里补 DESC + id DESC
            index.Fields("recipient_id", "state", "created_at"),
            index.Fields("donor_id", "created_at"),
            index.Fields("post_id"),
            index.Fields("channel_id"),
            index.Fields("verified_by"),
        }
    }

### 4.2 `schema/user_donation_setting.go`

    Fields:
      field.Int64("user_id")                                        // 主键，手写迁移设 PRIMARY KEY
      field.Bool("show_channels").Default(false)
      field.Bool("records_public").Default(false)
      field.Bool("notice_visible").Default(true)
      field.String("notice_text").MaxLen(200).Default("")
      field.Time("created_at").Default(time.Now).Immutable()
      field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now)
    Edges:
      edge.To("user", User.Type).Field("user_id").Unique().Required()
    Indexes:
      index.Fields("user_id").Unique()      // ent 用它表达「唯一」，迁移里改成 PRIMARY KEY

### 4.3 `schema/donation_notice_default.go`

    Fields:
      field.String("channel").MaxLen(16)    // 主键（手写迁移）
      field.String("text").MaxLen(200).Default("")
      created_at / updated_at 同 4.2
    Indexes:
      index.Fields("channel").Unique()

### 4.4 `schema/report.go`

    Fields:
      field.UUID("public_id", uuid.UUID{}).Unique().Immutable()
      field.String("target_type").MaxLen(16)
      field.Int64("target_id")
      field.String("reason").MaxLen(500)
      field.String("detail").MaxLen(1000).Default("")
      field.Int64("reporter_id")
      field.String("state").MaxLen(16).Default("open")
      field.Int64("handler_id").Optional().Nillable()
      field.Time("handled_at").Optional().Nillable()
      field.String("handle_note").MaxLen(500).Default("")
      created_at / updated_at
    Edges:
      edge.From("reporter", User.Type).Ref("reports_made").Field("reporter_id").Required().Unique()
      edge.From("handler",  User.Type).Ref("reports_handled").Field("handler_id").Unique()
    Indexes:
      index.Fields("state", "created_at")
      index.Fields("reporter_id", "created_at")
      index.Fields("handler_id")
      index.Fields("target_type", "target_id")
      // uq_reports_once（部分唯一）**不写进 schema**：写进去只会得到一份无法表达
      //   WHERE state='open' 的假声明，真正生效的是手写迁移里那一条。

### 4.5 `schema/site_setting.go`

    Fields:
      field.String("key").MaxLen(64)             // 主键（手写迁移）
      field.String("value").Default("")          // text，无长度上限
      field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now)
    Indexes:
      index.Fields("key").Unique()
    // 没有 created_at：这是配置快照，不是实体（偏差记录在 §4.9）

### 4.6 `schema/site_domain.go`

    Fields:
      field.String("domain").MaxLen(253)         // 主键；写入前 lower() 归一化
      field.Time("created_at").Default(time.Now).Immutable()
    Indexes:
      index.Fields("domain").Unique()

### 4.7 `announcement.go` / `banner.go` / `banner_role.go` / `banner_dismissal.go`

    Announcement:
      Fields: public_id uuid unique immutable; title MaxLen(120); body_md / body_html 用 field.Text();
              enabled bool Default(true); published_at time Optional Nillable;
              created_by int64 Optional Nillable; created_at / updated_at
      Edges:  edge.From("creator", User.Type).Ref("announcements").Field("created_by").Unique()
      Indexes: index.Fields("published_at")、index.Fields("created_by")   // 部分谓词在手写迁移

    Banner:
      Fields: public_id uuid unique immutable; kind MaxLen(8); text MaxLen(200);
              url field.Text().Optional().Nillable(); starts_at time Default(time.Now);
              ends_at time Optional Nillable; enabled bool Default(true);
              created_by int64 Optional Nillable; created_at / updated_at
      Edges:  edge.From("creator", User.Type).Ref("banners").Field("created_by").Unique()
      Indexes: index.Fields("enabled","starts_at")、index.Fields("created_by")

    BannerRole（显式关联实体，不用 ent 的 M2M 跳过表 —— 因为要写 role 侧索引）:
      Fields: banner_id int64; role_id int64
      Edges:  edge.To("banner", Banner.Type).Field("banner_id").Unique().Required();
              edge.To("role",   Role.Type).Field("role_id").Unique().Required()
      Indexes: index.Fields("role_id")

    BannerDismissal:
      Fields: banner_id int64; user_id int64; created_at
      Edges:  edge.To("banner", Banner.Type).Field("banner_id").Unique().Required();
              edge.To("user",   User.Type).Field("user_id").Unique().Required()
      Indexes: index.Fields("user_id","banner_id").Unique()

### 4.8 `mail_account.go` / `mail_quota.go` / `mail_log.go`

    MailAccount:
      Fields:
        field.UUID("public_id", uuid.UUID{}).Unique().Immutable()
        field.String("name").MaxLen(64).Unique()
        field.String("provider").MaxLen(8)
        field.Int("priority").Default(0)
        field.Int("daily_limit").Default(100)
        field.String("reset_tz").MaxLen(64).Default("Asia/Shanghai")
        field.String("from_address").MaxLen(254)
        field.String("from_name").MaxLen(64).Default("")
        field.JSON("options_json", json.RawMessage{}).Default(json.RawMessage("{}"))
        field.Bytes("secret_cipher").Optional().Nillable()
        field.Bytes("secret_nonce").Optional().Nillable()
        field.Time("secret_updated_at").Optional().Nillable()
        field.Bool("enabled").Default(true)
        field.Time("archived_at").Optional().Nillable()
        field.Time("last_ok_at").Optional().Nillable()
        field.String("last_error").Optional().Nillable()
        field.Time("last_error_at").Optional().Nillable()
        created_at / updated_at

    MailQuota:
      Fields: field.Int64("account_id");
              field.Time("day").SchemaType(map[string]string{dialect.Postgres: "date"});
              field.Int("count").Default(0); field.Time("updated_at")...
      Edges:  edge.To("account", MailAccount.Type).Field("account_id").Unique().Required()
      Indexes: index.Fields("account_id","day").Unique()   // 迁移里改成 PRIMARY KEY

    MailLog:
      Fields: field.String("idempotency_key").MaxLen(128).Unique();
              field.String("to_address").MaxLen(254); field.String("template").MaxLen(64);
              field.JSON("payload", json.RawMessage{}).Default(json.RawMessage("{}"));
              field.String("status").MaxLen(8).Default("pending");
              field.String("provider").MaxLen(32).Default("");
              field.String("provider_message_id").Optional().Nillable();   // text
              field.String("error").Optional().Nillable();
              field.Int("attempts").Default(0);
              field.Int64("quota_account_id").Optional().Nillable();
              field.Time("quota_day").Optional().Nillable().SchemaType(date);
              field.Time("sent_at").Optional().Nillable(); created_at / updated_at
      Edges:  edge.To("quota_account", MailAccount.Type).Field("quota_account_id").Unique()
      Indexes: index.Fields("status","created_at")、index.Fields("quota_account_id")

### 4.9 与全局约定的三处有意偏差（写下来，避免被当成疏漏）

1. `site_settings` 没有 `created_at`：配置表，`updated_at` 就够。数据库文档 §2.12 的「每张表都有 created_at」在这张表上按「配置表不适用」处理。
2. `user_donation_settings` / `donation_notice_defaults` / `mail_quota` 的主键不是 `id identity`：它们是「一人一行 / 一渠道一行 / 一账号一天一行」的自然键，再加自增主键只会让唯一性靠第二个索引维持。
3. `banner_roles` 没有 `created_at`：纯关联表（与 `role_permissions`、`topic_images` 同类）。

---

## 5. Go 接口

### 5.1 `internal/platform` 侧（纯技术件）

    // internal/platform/mail/mail.go
    type Message struct {
        From    Address
        To      Address
        Subject string
        HTML    string
        Text    string
        Headers map[string]string   // 只有 provider 支持时才用（Idempotency-Key）
    }
    type Address struct{ Address, Name string }

    type Provider interface {
        Send(ctx context.Context, m Message) (providerMessageID string, err error)
    }
    type Factory interface {
        // 按账号构建 provider（内部解密凭据并缓存）；凭据缺失/密钥不对 → 包装过的 ErrPermanent
        New(a Account) (Provider, error)
    }

    var (
        ErrQuotaExceeded = errors.New("mail: provider quota exceeded")
        ErrTemporary     = errors.New("mail: temporary failure")
        ErrPermanent     = errors.New("mail: permanent failure")
        ErrNoProvider    = errors.New("mail: no provider with quota")
    )
    func Classify(err error) error   // provider 原始错误 → 上面三类（原始错误用 %w 包住）

    // internal/platform/mail/crypto.go
    type Crypter struct{ /* key, oldKeys */ }
    func NewCrypter(keyHex, oldKeysHex string) (*Crypter, error)   // key 必须 32 字节 hex，否则报错
    func (c *Crypter) Encrypt(plain, aad []byte) (cipher, nonce []byte, err error)
    func (c *Crypter) Decrypt(cipher, nonce, aad []byte) ([]byte, error)

    // internal/platform/mail/router.go
    type Account struct {
        ID          int64
        Name        string
        Provider    string
        Priority    int
        DailyLimit  int
        ResetTZ     string
        FromAddress string
        FromName    string
        Options     json.RawMessage
        Secret      []byte    // 已解密；只在这份结构里存活，禁止进日志/审计/响应
    }
    type Acquired struct {
        Account   Account
        Day       time.Time   // 额度所属自然日（账号 reset_tz 的日期）
        NewlyHeld bool        // true = 本次调用占用了 1 次额度
    }
    type Router struct{ /* db *ent.Client, crypter, factory, clock, log, cache */ }
    func NewRouter(db *ent.Client, c *Crypter, f Factory, clk clock.Clock, log *slog.Logger, cacheTTL time.Duration) *Router

    func (r *Router) Acquire(ctx context.Context, exclude map[int64]bool) (*Acquired, error)
    func (r *Router) Reuse(ctx context.Context, accountID int64, day time.Time) (*Acquired, error)
    func (r *Router) Send(ctx context.Context, a *Acquired, m Message) (string, error)
    func (r *Router) MarkExhausted(a *Acquired)              // 内存熔断，key = name + day
    func (r *Router) RecordFailure(a *Acquired, msg string)  // 写 last_error / last_error_at
    func (r *Router) RecordSuccess(a *Acquired)              // 写 last_ok_at
    func (r *Router) NextReset(a *Acquired) time.Time        // 该账号下一个自然日 00:30（reset_tz）
    func (r *Router) Invalidate()                            // 后台写操作后调用

    // internal/platform/audit/audit.go
    type Entry struct {
        ActorID    *int64
        Action     string
        TargetType string
        TargetID   string
        Detail     map[string]any    // 统一 {"before":…,"after":…}
        IP         string
    }
    type Writer struct{ /* db *ent.Client */ }
    func NewWriter(db *ent.Client) *Writer
    func (w *Writer) Write(ctx context.Context, tx *ent.Tx, e Entry) error   // 必须传 tx

### 5.2 `internal/reward`

    type Service struct{ db *ent.Client; q Queue; users UserLookup; audit *audit.Writer; clk clock.Clock; log *slog.Logger }
    func NewService(db *ent.Client, q Queue, users UserLookup, a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service

    // deps.go
    type Queue interface {
        EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
    }
    type UserLookup interface {
        IDByHandle(ctx context.Context, handle string) (int64, error)
        Basic(ctx context.Context, userID int64) (UserBasic, error)   // 昵称/头像/状态
    }

    // 用户侧
    func (s *Service) Channels(ctx context.Context, actor *authz.Actor, handle string) (*Channels, error)
    func (s *Service) CreateDonation(ctx context.Context, actor *authz.Actor, in CreateDonationInput) (*Donation, error)
    func (s *Service) ListMyDonations(ctx context.Context, actor *authz.Actor, in CursorInput) (*DonationPage, error)
    func (s *Service) ListUserDonations(ctx context.Context, actor *authz.Actor, in UserDonationsInput) (*DonationPage, error)
    func (s *Service) WithdrawDonation(ctx context.Context, actor *authz.Actor, publicID string) error
    func (s *Service) GetMySettings(ctx context.Context, actor *authz.Actor) (*DonationSettings, error)
    func (s *Service) UpdateMySettings(ctx context.Context, actor *authz.Actor, in UpdateDonationSettingsInput) (*DonationSettings, error)

    // 管理侧
    func (s *Service) ListQueue(ctx context.Context, actor *authz.Actor, in QueueInput) (*DonationPage, error)
    func (s *Service) Verify(ctx context.Context, actor *authz.Actor, publicID string, in VerifyInput) (*Donation, error)
    func (s *Service) VerifyBatch(ctx context.Context, actor *authz.Actor, in BatchVerifyInput) (*BatchResult, error)
    func (s *Service) Stats(ctx context.Context, actor *authz.Actor, in StatsInput) (*DonationStats, error)
    func (s *Service) GetNoticeDefaults(ctx context.Context, actor *authz.Actor) ([]NoticeDefault, error)
    func (s *Service) UpdateNoticeDefaults(ctx context.Context, actor *authz.Actor, in NoticeDefaultsInput) ([]NoticeDefault, error)

### 5.3 `internal/report`

    func NewService(db *ent.Client, tg TargetResolver, a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service

    func (s *Service) Create(ctx context.Context, actor *authz.Actor, in CreateReportInput) (*Report, error)
    func (s *Service) ListMine(ctx context.Context, actor *authz.Actor, in CursorInput) (*ReportPage, error)
    func (s *Service) ListQueue(ctx context.Context, actor *authz.Actor, in QueueInput) (*ReportPage, error)
    func (s *Service) Handle(ctx context.Context, actor *authz.Actor, publicID string, in HandleInput) (*Report, error)
    func (s *Service) HandleBatch(ctx context.Context, actor *authz.Actor, in BatchHandleInput) (*BatchResult, error)

    // deps.go
    type TargetResolver interface {
        // 举报要校验目标存在；targetID 是对外 id，返回内部 id
        Resolve(ctx context.Context, targetType, publicID string) (internalID int64, exists bool, err error)
    }

### 5.4 `internal/site`

    type Service struct{ db *ent.Client; cfg Config; md Markdown; audit *audit.Writer; cache *settingsCache; clk clock.Clock; log *slog.Logger }
    func NewService(db *ent.Client, cfg Config, md Markdown, a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service

    func (s *Service) GetSite(ctx context.Context, actor *authz.Actor) (*Site, error)
    func (s *Service) DismissBanner(ctx context.Context, actor *authz.Actor, publicID string) error
    func (s *Service) GetSettings(ctx context.Context, actor *authz.Actor) (*SettingsView, error)
    func (s *Service) UpdateSettings(ctx context.Context, actor *authz.Actor, in SettingsInput) error
    func (s *Service) ListDomains(ctx context.Context, actor *authz.Actor) ([]Domain, error)
    func (s *Service) RegisterBaseDomain(ctx context.Context) error        // 启动时调一次

    func (s *Service) ListAnnouncements(ctx context.Context, actor *authz.Actor, in CursorInput) (*AnnouncementPage, error)
    func (s *Service) CreateAnnouncement(ctx context.Context, actor *authz.Actor, in AnnouncementInput) (*Announcement, error)
    func (s *Service) UpdateAnnouncement(ctx context.Context, actor *authz.Actor, publicID string, in AnnouncementPatch) (*Announcement, error)

    func (s *Service) ListBanners(ctx context.Context, actor *authz.Actor, in CursorInput) (*BannerPage, error)
    func (s *Service) CreateBanner(ctx context.Context, actor *authz.Actor, in BannerInput) (*Banner, error)
    func (s *Service) UpdateBanner(ctx context.Context, actor *authz.Actor, publicID string, in BannerPatch) (*Banner, error)

    func (s *Service) RenderMarkdown(ctx context.Context, actor *authz.Actor, in PreviewInput) (*Preview, error)

    // deps.go
    type Markdown interface{ Render(md string) (string, error) }
    type Config interface {
        BaseURL() string
        Debug() bool
    }

    // settings.go —— 键值表的唯一真源
    type SettingSpec struct {
        Key     string
        Label   string
        Group   string    // 站点 / 注册与审核 / 赞赏 / 邮件
        Kind    string    // text / multiline / toggle / select
        Options []string  // 仅 select
        Default string
    }
    func SettingSpecs() []SettingSpec

**键值表是**（与 `web/src/devroom/pages/15-admin/mock/system.ts` 的 10 个 key 逐字一致；契约测试 §10 第 53 条钉住，防两处漂移）：

| key | kind | 默认值 | 谁读 |
|---|---|---|---|
| `site.name` | text | `SC2clud 战役作者社区` | 壳注入、邮件落款、`/site` |
| `site.tagline` | text | （空） | meta description、首页 |
| `site.footer_note` | multiline | （空） | 页脚 |
| `registration.open` | toggle | on | `internal/auth` 注册端点 |
| `registration.require_activation` | toggle | on | `internal/auth`（激活轴） |
| `post.review_policy` | select(untrusted/all/off) | untrusted | `internal/forum` 发帖 |
| `donation.enabled` | toggle | on | `internal/reward`（关掉后收款码与申报入口全隐） |
| `donation.notice_default` | multiline | `如果这份战役帮到了你，可以扫码支持作者。站点不经手资金。` | `internal/reward` 的兜底文案 |
| `mail.enabled` | toggle | on | `internal/mail` 投递任务 |
| `mail.from_name` | text | `SC2clud` | 账号级 `from_name` 为空时的回落 |

### 5.5 `internal/mail`

    type Service struct{ db *ent.Client; r *pgmail.Router; crypter *pgmail.Crypter; cfg Config; q Queue; clk clock.Clock; log *slog.Logger }
    func NewService(db *ent.Client, r *pgmail.Router, c *pgmail.Crypter, cfg Config, q Queue, clk clock.Clock, log *slog.Logger) *Service

    // 业务侧唯一入口（其它模块只能通过自己 deps.go 里的小接口看到它）
    func (s *Service) EnqueueTx(ctx context.Context, tx *ent.Tx, in EnqueueInput) error
    // EnqueueInput: { RecipientID int64; ToAddress string; Template string; Payload map[string]any; IdempotencyKey string }
    // 做两件事：INSERT mail_logs（幂等键 + 收件人地址快照）→ queue.EnqueueTx(TypeMailSend, {"id": <id>})
    // 幂等键由调用方给（verify:<user_id>:<token_id> / reset:<user_id>:<token_id>）；
    // 不给时按 RecipientID + Template 算一个（同一人同一模板只留一条未完成的）。

    func (s *Service) SendTest(ctx context.Context, actor *authz.Actor, accountPublicID string) (*SendTestResult, error)

    func (s *Service) ListAccounts(ctx context.Context, actor *authz.Actor) ([]AdminAccount, error)  // 含 sent_today
    func (s *Service) CreateAccount(ctx context.Context, actor *authz.Actor, in AccountInput) (*AdminAccount, error)
    func (s *Service) UpdateAccount(ctx context.Context, actor *authz.Actor, accountPublicID string, in AccountPatch) (*AdminAccount, error)
    func (s *Service) DeleteAccount(ctx context.Context, actor *authz.Actor, accountPublicID string) (*DeleteResult, error)
    // Delete：有 mail_logs 引用 → 归档（archived_at + enabled=false），DeleteResult.Archived=true；无引用 → 硬删

    // tasks.go —— 本模块唯一的任务处理器
    func (s *Service) HandleMailSend(ctx context.Context, payload []byte) error

    // deps.go
    type Queue interface{ EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error }
    type Config interface {
        KeyHex() string
        OldKeysHex() string
        CacheTTL() time.Duration
    }

**那两把密钥怎么落到 Config**：`config.Mail.KeyHex` 与 `OldKeyHex` 就是 config 结构体字段（v2 §13.3），`Config@@ 接口只是把它收窄成本模块看到的三个方法 —— **不新增配置项**。

**模板**（`internal/mail/templates/`，`//go:embed templates`）：

    每个模板一对文件：verify_email.html.tmpl + verify_email.txt.tmpl，reset_password.*、test.*、notice.*
    渲染：html/template 渲染 HTML、text/template 渲染纯文本，两者只接收同一个结构体：
      type Data struct{ SiteName, Nickname, ActionURL, Code string; ExpiresMinutes int }
    禁止把用户输入拼进模板 HTML（v2 §8.5）。
    mail_logs.template 的 CHECK 值域 == Go 常量集合 == templates/ 下的模板名集合（自检 §10 第 49 条）。

### 5.6 Handler 与路由注册

    // internal/reward/handler.go（report / site / mail 同构）
    type Handler struct{ svc *Service }
    func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }
    func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc, perm func(...string) gin.HandlerFunc)
    // handler 里：actor, ok := auth.FromGin(c); if !ok { 401 }；显式传给 service（拍板 §5.3，禁止 ctx.Value）

逐条路由（本域全部端点，**这就是要回写 §21.2 的清单**）：

| 方法 | 路径 | 登录 | 权限点 | 模块 | 备注 |
|---|---|---|---|---|---|
| GET | /api/v1/users/{handle}/channels | — | — | reward | show_channels=false → data: [] |
| POST | /api/v1/rewards | ✔ | — | reward | 201 |
| GET | /api/v1/me/rewards | ✔ | — | reward | 游标 |
| GET | /api/v1/users/{handle}/rewards | — | — | reward | 只 approved + 双方公开 |
| DELETE | /api/v1/rewards/{id} | ✔ | — | reward | 204；仅本人 pending；重复撤回也 204 |
| GET | /api/v1/me/donation-settings | ✔ | — | reward | |
| PATCH | /api/v1/me/donation-settings | ✔ | — | reward | 部分字段 |
| GET | /api/v1/admin/rewards | ✔ | reward.verify | reward | ?state=&limit=&cursor= |
| POST | /api/v1/admin/rewards/{id}/verify | ✔ | reward.verify | reward | {state, note?} |
| POST | /api/v1/admin/rewards/batch | ✔ | reward.verify | reward | {ids[], state, note?}，逐条结果 |
| GET | /api/v1/admin/rewards/stats | ✔ | reward.verify | reward | 收入 / 按帖 / 排行 / 支出 |
| GET | /api/v1/admin/donation-notice-defaults | ✔ | site.setting | reward | |
| PATCH | /api/v1/admin/donation-notice-defaults | ✔ | site.setting | reward | 传数组 = 整表替换 |
| POST | /api/v1/reports | ✔ | — | report | 201；重复举报返回 200 + 既有行 |
| GET | /api/v1/me/reports | ✔ | — | report | 游标 |
| GET | /api/v1/admin/reports | ✔ | report.handle | report | ?state=&target_type=&limit=&cursor= |
| PATCH | /api/v1/admin/reports/{id} | ✔ | report.handle | report | {state, note?} |
| POST | /api/v1/admin/reports/batch | ✔ | report.handle | report | 逐条结果 |
| GET | /api/v1/site | — | — | site | 站点名/简介/公告/生效横幅 |
| POST | /api/v1/banners/{id}/dismiss | ✔ | — | site | 幂等，永远 204 |
| POST | /api/v1/markdown/preview | ✔ | — | site | 归属见 U9 |
| GET | /api/v1/admin/site-settings | ✔ | site.setting | site | 带 schema |
| PATCH | /api/v1/admin/site-settings | ✔ | site.setting | site | 未知 key → 400 |
| GET | /api/v1/admin/site-domains | ✔ | site.setting | site | 只读 |
| GET | /api/v1/admin/announcements | ✔ | site.setting | site | 游标 |
| POST | /api/v1/admin/announcements | ✔ | site.setting | site | 201 |
| PATCH | /api/v1/admin/announcements/{id} | ✔ | site.setting | site | 改 / 发布 / 下线 |
| GET | /api/v1/admin/banners | ✔ | site.setting | site | 游标 |
| POST | /api/v1/admin/banners | ✔ | site.setting | site | 201 |
| PATCH | /api/v1/admin/banners/{id} | ✔ | site.setting | site | 改 / 启停 / 改定向 |
| GET | /api/v1/admin/mail/accounts | ✔ | mail.manage | mail | 绝不回凭据 |
| POST | /api/v1/admin/mail/accounts | ✔ | mail.manage | mail | 201 |
| PATCH | /api/v1/admin/mail/accounts/{id} | ✔ | mail.manage | mail | 凭据留空 = 不改；**body 没有 name 字段** |
| DELETE | /api/v1/admin/mail/accounts/{id} | ✔ | mail.manage | mail | 204；被引用则归档 |
| POST | /api/v1/admin/mail/accounts/{id}/test | ✔ | mail.manage | mail | 202 + mail_log_id |

**请求体上限**（v2 §9.6：按路由设，不全局一刀切）：本域全部路由 1 MB；`POST /api/v1/markdown/preview` 2 MB（正文可以很长）。

**`{id}` 一律是 public_id**（拍板 §5.6）：因此 reports / banners / announcements / mail_accounts / donation_records 都建了 `public_id`。`site_settings` / `site_domains` / `donation_notice_defaults` 的对外标识是它们的自然键（key / domain / channel），与「禁止暴露自增 id」不冲突。

---

## 6. 业务规则

### 6.1 赞赏申报（POST /api/v1/rewards）

1. 入参校验（HTTP 边界）：`amount_cents` 属于 [1, 99999999]（约 100 万元）、`txn_id` 不得超 64 字符、`note` 不得超 200；
2. `donor == recipient@@ → 400 `common.invalid_input`（fields: to_handle）。DB 的 `ck_donation_records_not_self` 是兜底，不是用户提示；
3. `donation.enabled = off` → 403 `reward.disabled`；
4. 收款人 `status <> 'active'` → 404 `common.not_found`（封号用户不收赞赏，且不泄露其状态）；
5. 给了 `post_id`：必须存在、`status='normal'`、且 `author_id = recipient_id`（在别人帖子里给第三者打赏是数据错 → 400）；
6. 给了 `channel_id`：必须属于 recipient（它只记录「当时展示的是哪张码」）；
7. 插入（`public_id` = v7）→ 201。**没有幂等键**：同一个人给同一个人打赏两次是合法的（金额不同），重复申报由管理员合并/驳回（v2 §12.3：`txn_id` 不加唯一约束）；
8. 限流 `reward:create:user:<id>` 10 次/小时（新增，写进 v2 §9.4 表）—— 防刷屏式申报把核验队列埋掉。

### 6.2 撤回（DELETE /api/v1/rewards/{id}）

唯一合法转换：`pending → withdrawn`，且**只有 donor 本人**。撤回不挂权限点（每个用户都能撤自己的），所以 service 里只判 `row.donor_id == actor.UserID`。**管理员也不能替别人撤回**（撤回是申报人的意思表示）。重复撤回 → 204（幂等：目的已达成）；撤别人的 → 404（不泄露存在性）；撤自己的 approved/rejected → 403 `common.forbidden`。

### 6.3 核验（POST /admin/rewards/{id}/verify）—— 本域最需要写清的一处

- body `{ state: "approved" | "rejected", note?: string }`；`state` 用 binding 的 `oneof` 限死两个值（`withdrawn` 会被 400 挡住）。
- **幂等**：同一请求重放（网络重发 / 双击）→ 第二次 409 `reward.already_handled`。前端要把 409 当「已处理，刷新列表」，不是错误弹窗。
- **改判**：`approved <-> rejected` 允许，**必须写审计**（action=`reward.verify`，detail 带 before/after）。
- **`withdrawn`**：409 `reward.invalid_transition`（用户的撤回不能被管理员单方面推翻）。
- **批量核验**（`POST /admin/rewards/batch`）：`{ids: [public_id...], state, note?}`，`max_ids = 100`，**单个事务**，逐条 CAS，返回 `{results: [{id, ok, code?}]}`。
  - 为什么不是「全成功或全回滚」（界面需求 §5.1 明确不要）：一条重复核验就让 20 条一起失败，管理员会疯。
  - 为什么不是「一条一个事务」：一次核验是**一个管理员意图**，拆成 100 个事务只会把 16 条连接的池子占满；结果语义（逐条成败）两者相同。
  - 事务里逐条写 audit + `EnqueueTx(notify:reward)` —— 100 条产生 100 个任务是对的（每个收款人一条通知）。
- **核验页必须显示的免责文案**（v2 §12.3）：「金额只用于展示与统计，站点不校验支付真实性；请核对对方贴出的单号/截图。」—— 这是前端页面常量，**不进后端代码**。

### 6.4 统计口径

统计**只算 `state='approved'`**，且**只看双方都同意公开**：

    公开 = user_donation_settings.records_public(donor)  AND  user_donation_settings.show_channels(recipient)

为什么是**两个开关**而不是一个：`records_public` 是打赏人「我的记录可以公开」的授权，`show_channels` 是收款人「我接受被展示」的授权。用一个开关去授权另一个人的数据公开是错的。缺一即私有。

- `GET /users/{handle}/rewards`：只返回公开的（游客可看）；
- `GET /admin/rewards/stats`（`reward.verify`）：返回全部口径，响应里同时给 `public_total_cents` 与 `all_total_cents`，避免前后端各算一套；
- `/admin/rewards` 队列永远返回全部（管理员本来就在核验这些数据）。

### 6.5 举报（POST /api/v1/reports）

1. `target_type` 属于 {topic, post, user}；`target_id` 是**对外 id**，service 通过 `TargetResolver` 换成内部 id；不存在 / 已 deleted → 404 `common.not_found`；
2. 不能举报自己的内容（比自己 → 400 `common.invalid_fields`）—— 产品判断，写在 U4；
3. `reason` 不得超 500 且必填、`detail` 不得超 1000 且选填；
4. 插入撞 `uq_reports_once` → **不是 409**：返回 200 + 已存在的那条（连点两次举报不该看到错误）。这是「幂等」在这条 POST 上的落法（契约是 POST，不能改成 PUT）；
5. 限流 `report:create:user:<id>` 10 次/小时。

### 6.6 处理举报（PATCH /admin/reports/{id}）

- body `{state: "handled" | "dismissed", note?: string}`；`handled` 时 `note` **必填**（不得超 500）——「已处理」不写做了什么等于没处理；`dismissed` 时选填；
- 与核验同构：CAS + 409 `report.already_handled` + 审计；
- **不联动封号**：处理举报与 `user.ban` 是两个权限点。处理举报不会自动封人 —— 把两件事绑一起等于「处理举报的人顺手有了封号权」。前端给个去用户页的跳转即可；
- 批量同 §6.3。

### 6.7 站点设置（PATCH /admin/site-settings）—— 未知 key 必须 400 的落法

    func (s *Service) UpdateSettings(ctx context.Context, actor *authz.Actor, in SettingsInput) error {
        authz.Require(actor, authz.PermSiteSetting)

        specs := map[string]SettingSpec{}
        for _, sp := range SettingSpecs() { specs[sp.Key] = sp }

        fields := map[string]string{}
        for k, v := range in.Values {
            sp, ok := specs[k]
            if !ok { fields[k] = "未知的站点设置键"; continue }
            if len(v) > 2000 { fields[k] = "值过长（不超过 2000）"; continue }
            switch sp.Kind {
            case "toggle":
                if v != "on" && v != "off" { fields[k] = "只能是 on / off" }
            case "select":
                if !slices.Contains(sp.Options, v) { fields[k] = "取值不在允许范围内" }
            }
        }
        if len(fields) > 0 { return apperr.Invalid(fields) }   // 400 common.invalid_input + fields，不写库

        old := map[string]string{}
        err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
            rows, err := tx.SiteSetting.Query().Where(sitesetting.KeyIn(keysOf(in.Values)...)).All(ctx)
            if err != nil { return fmt.Errorf("读旧站点设置: %w", err) }
            for _, r := range rows { old[r.Key] = r.Value }

            for k, v := range in.Values {
                if err := upsertSetting(ctx, tx, k, v); err != nil { return err }   // §7.12
                if err := s.audit.Write(ctx, tx, audit.Entry{
                    ActorID: &actor.UserID, Action: "site.setting.update",
                    TargetType: "site", TargetID: k,
                    Detail: map[string]any{"before": old[k], "after": v},
                    IP: in.IP,
                }); err != nil { return err }
            }
            return nil
        })
        if err != nil { return err }
        s.cache.Invalidate()
        return nil
    }

三条性质：**全验后写**（不会写一半）、**单事务**（全成或全不成）、**每 key 一条审计**。返回 200 + 新的设置视图（前端用它刷新「已保存」态）。

### 6.8 横幅与公告

**生效中的横幅**（`GET /api/v1/site` 里）：

    可见 = enabled
       AND starts_at <= now()
       AND (ends_at IS NULL OR ends_at > now())
       AND (该横幅没有 banner_roles 行  OR  存在 banner_roles.role_id = actor.role_id)
       AND NOT EXISTS (banner_dismissals WHERE banner_id = b.id AND user_id = actor.UserID)

游客（actor == nil）：只返回**没有 banner_roles 行**的横幅 —— 定向横幅对游客不可见。

**定向用角色**（拍板 §20.2 第 13 条）：`banner_roles` 空 = 所有人。这是「表里没有行」的语义，不是第二份真源。

**「不再显示」**：`INSERT ... ON CONFLICT (banner_id, user_id) DO NOTHING`，永远 204。

**公告**：`GET /site` 只返回最近 3 条 `enabled AND published_at IS NOT NULL`；正文与帖子走同一条渲染链（`platform/markdown`：goldmark 然后 bluemonday UGCPolicy），**不允许未清洗 HTML 进 body_html**。

**URL 校验（信任边界）**：`banners.url` 只接受 `http/https` 绝对 URL 或站内相对路径（以 `/` 开头且不以 `//` 开头）；`javascript:` / `data:` → 400 `site.bad_url`。前端会把它直接放进 `<a href>`。

### 6.9 域名登记（启动时）

    RegisterBaseDomain(ctx):
      host := lower(url.Parse(cfg.BaseURL()).Hostname())    // 去 scheme、去端口
      if host == "" { log.Warn("base_url 未配置或不可解析，跳过域名登记"); return nil }
      INSERT INTO site_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING
      若 RowsAffected = 1 → log.Warn("已自动登记 base_url 域名", host)
      若表为空 → log.Warn("site_domains 为空：站内链接解析与发信回跳只认 base_url")

**只 Warn，不拒绝启动**：域名白名单是「解析站内链接」与「发信回跳」用的，缺了它的表现是「某些域名的链接不解析」，不是安全问题；拒绝启动会让人进不去修。自检面板的检查项：`site_domains` 是否包含 base_url 的 host。

### 6.10 发信账号 CRUD

- **凭据只写不读**：GET 永远不返回 `secret_cipher` / `secret_nonce`，只返回 `secret_configured: bool` 与 `secret_updated_at`。响应 DTO **里根本没有这两个字段** —— 不是「查询时 select 掉」，没有字段就不会漏。
- **密文格式**（v2 §8.7 缺节，这里补上）：

      secret_cipher = 0x01 || Seal(plaintext, nonce, aad)   -- chacha20poly1305，tag 是后 16 字节
      secret_nonce  = 12 字节随机 nonce（每次加密新生成，与密文分开存）
      AAD           = mail_accounts.name 的 UTF-8 字节
      版本字节在最前面：以后换算法靠它区分（现在只认 0x01，其它值 → 解密失败 + Warn）

  **为什么 AAD 绑 name 而不是 id**（盲审建议的是 id 的十进制串）：插入前拿不到 id，用 id 做 AAD 就必须「先插占位、再 UPDATE 密文」，多一条路径、多一个可能半完成的状态。`name` 是 `UNIQUE NOT NULL` 且**不可改**，同样把密文绑死在账号上，而且插入前就有值。
- **name 不可改**：`PATCH /accounts/{id}` 的 body 里**没有 name 字段**。要改名就新建一个账号再归档旧的（归档本来就是被历史 MailLog 引用时的路径）。
- **密钥轮换**：`Decrypt` 先试 `key`，再逐个试 `old_keys`；用旧钥解开时**立即用新钥重写同一行**（同一事务），记 Info。全部试完都不行 → 该账号跳过 + Warn（不阻塞启动：进不了后台就改不了账号）。
- **日志与审计**：只出现 `secret_updated_at` 与 `secret_configured`，**永不出现密文、明文、nonce**。`options_json` 是非敏感的（SMTP 的 host/port/username 在里面；本地 SMTP 的 username 常等于发件地址，藏它会让后台无法确认配了哪个账号）。
- **删除**：有 `mail_logs` 引用 → 归档（`archived_at = now, enabled = false`），响应 `{archived: true}`；无引用 → 硬删。证据（发信历史）不因为删账号而消失（`quota_account_id ON DELETE SET NULL`）。
- **测试发信**：`POST /accounts/{id}/test` → 用该账号给**当前管理员**发一封 `template='test'` 的信 → 202 + `{mail_log_id}`。它也走 `EnqueueTx`（不直接发）：直接发会绕过额度账，且把 HTTP 超时变成 SMTP 超时。

### 6.11 `mail:send` 任务

    func (s *Service) HandleMailSend(ctx context.Context, payload []byte) error {
        var p struct{ ID int64 }        // json 标签是 id
        if json.Unmarshal(payload, &p) != nil || p.ID == 0 { return queue.ErrSkipRetry }  // payload 是我们自己写的

        lg, err := s.loadLog(ctx, p.ID)            // SELECT ... WHERE id = $1（§7.4）
        if err != nil { return err }               // 库暂时不可用 → 让队列重试
        if lg.Status == "sent" { return nil }      // 幂等（M3 验收项）
        if !s.mailEnabled(ctx) {                   // site_settings.mail.enabled = off
            return s.fail(ctx, lg.ID, "mail.enabled = off", queue.ErrSkipRetry)
        }
        data, err := render(lg)                    // 模板 + 收件人
        if err != nil { return s.fail(ctx, lg.ID, err.Error(), queue.ErrSkipRetry) }  // 模板缺字段 = 代码 bug

        exclude := map[int64]bool{}
        for {
            a, err := s.acquireFor(ctx, lg, exclude)     // 复用已占额度，否则新占（§7.3/§7.4）
            if err != nil { return err }                 // 含 ErrSkipRetry / ErrNoProvider / 库错误

            msgID, serr := s.r.Send(ctx, a, build(a, data))
            switch {
            case serr == nil:
                s.r.RecordSuccess(a)
                return s.markSent(ctx, lg.ID, a, msgID)              // status=sent, sent_at, attempts+1
            case errors.Is(serr, pgmail.ErrQuotaExceeded):
                s.r.MarkExhausted(a); s.r.RecordFailure(a, serr.Error())
                exclude[a.Account.ID] = true
            case errors.Is(serr, pgmail.ErrTemporary):
                s.r.RecordFailure(a, serr.Error())
                exclude[a.Account.ID] = true
            case errors.Is(serr, pgmail.ErrPermanent):
                return s.fail(ctx, lg.ID, serr.Error(), queue.ErrSkipRetry)
            default:
                return s.fail(ctx, lg.ID, serr.Error(), nil)          // 未知错误 → 让队列重试
            }
            if err := s.saveQuotaBinding(ctx, lg.ID, a); err != nil { return err }  // 换账号后写回 MailLog
        }
    }

    // acquireFor：把「复用 / 新占」收在一处，避免两条路径各写一遍
    func (s *Service) acquireFor(ctx, lg, exclude) (*pgmail.Acquired, error) {
        if lg.QuotaAccountID != nil && lg.QuotaDay != nil && sameDay(lg.QuotaDay, lg.ResetTZ) {
            a, err := s.r.Reuse(ctx, *lg.QuotaAccountID, *lg.QuotaDay)   // 不占额度
            if err == nil { return a, nil }                              // 账号被停用/删除 → 落到新占
        }
        return s.r.Acquire(ctx, exclude)
    }

**额度用尽（ErrNoProvider）的处理**：`mail_logs` 保持 `pending`，`attempts+1`，记 `error='今日无可用发信额度'`，然后**把这条任务重排到明天**：

- 队列 API 的 `Task` 有 `RunAt`（v2 §7.4）。所以处理函数在返回 `nil` 之前调 `s.q.Enqueue(ctx, queue.Task{Type: TypeMailSend, Payload: payload, RunAt: minReset.Add(5*time.Minute)})`。
- 为什么不直接返回错误靠退避：退避上限 1 小时乘以默认 5 次约 31 小时就进 dead；而额度是**按自然日**重置的，第二天本来就能发。明确的「明天再来」比 5 次盲退避准确。
- 代价（写下来）：这条 `mail_logs` 会跨天停在 `pending`，后台「今天的失败数」不包含它 —— 它没失败，只是在等额度。

**为什么 Send 在事务外**：事务里禁止发 HTTP / 发邮件（v2 §14.6 / 拍板 §5.4）。所以「占额度 + 写回 MailLog」是一个短事务（§7.3），Send 在事务外，Send 之后再开一个短事务记结果。

---

## 7. SQL

> 约定：原生 SQL 只允许在 `platform/search/pgsql` 与手写迁移里（开发必读 §1 第 8 条）。因此下面**每条都给出 ent 写法 + 生成的 SQL 两栏**；标「原生」的那些，落点是 `internal/platform/mail/router.go`（按 v2 §4.2 规则 2，platform 允许 import `internal/ent`，用 `tx.ExecContext` 走 pgx 连接，**不新建 SQL 包**）。所有参数用 `$n` 占位，禁止字符串拼接。

### 7.1 收入侧合计（按收款人）

ent：

    sum, err := tx.DonationRecord.Query().
        Where(
            donationrecord.StateEQ("approved"),
            donationrecord.RecipientID(recipientID),
            donationrecord.HasRecipientWith(user.HasDonationSettingWith(userdonationsetting.ShowChannels(true))),
            donationrecord.HasDonorWith(user.HasDonationSettingWith(userdonationsetting.RecordsPublic(true))),
        ).
        Aggregate(ent.Sum(donationrecord.FieldAmountCents)).Int(ctx)

生成的 SQL：

    SELECT COALESCE(SUM(d.amount_cents), 0)
      FROM donation_records d
      JOIN user_donation_settings rs ON rs.user_id = d.recipient_id AND rs.show_channels  = true
      JOIN user_donation_settings ds ON ds.user_id = d.donor_id     AND ds.records_public = true
     WHERE d.state = 'approved' AND d.recipient_id = $1;

- 索引：`idx_donation_records_recipient (recipient_id, state, created_at DESC, id DESC)` —— 两列等值都在索引前缀 → **Index Scan**，不排序。
- JOIN 侧：`user_donation_settings` 的 PK（user_id）→ 每行一次 **Index Only Scan**。
- `EXPLAIN (ANALYZE)` 预期：`Index Scan using idx_donation_records_recipient on donation_records d (rows=N)`，N = 该收款人全部 approved 行数（典型个位数，重度作者最多几百）。**不会 Seq Scan**：条件两列都命中索引前缀。唯一的退化是某收款人有上万条 approved（现实不存在）；真到了就把 `records_public` 反范式到 `donation_records`（现在不做，备案）。

### 7.2 核验 CAS（幂等 + 并发）

ent：

    n, err := tx.DonationRecord.Update().
        Where(
            donationrecord.PublicID(publicID),
            donationrecord.StateIn("pending", "approved", "rejected"),  // 排除 withdrawn
            donationrecord.StateNEQ(target),                            // 同态重放不写
        ).
        SetState(target).SetVerifiedBy(actor.UserID).SetVerifiedAt(now).SetUpdatedAt(now).
        Save(ctx)
    if n == 0 {
        // 回查一次，决定 404 / 409 already_handled / 409 invalid_transition
    }

生成的 SQL：

    UPDATE donation_records
       SET state = $1, verified_by = $2, verified_at = $3, updated_at = $3
     WHERE public_id = $4
       AND state IN ('pending','approved','rejected')
       AND state <> $1;

- 走 `donation_records_public_id_key`（UNIQUE 索引）→ Index Scan，1 行。
- `state IN (...)` 里含 approved/rejected 是有意的：它让「改判」也只是一次 CAS，不需要先读再写。
- `state <> $1` 是幂等的关键：**同态重放** RowsAffected=0 → 409 `already_handled` 且**不写第二条审计**；**异态改判** RowsAffected=1 → 成功且写审计。没有这一条，重复点「通过」会写出第二条 `reward.verify` 审计，追责时无法区分「改判」与「重放」。
- 并发（两个管理员同时点同一条 pending，都点通过）：第一个拿行锁并提交；第二个在 READ COMMITTED 下重新求值 `WHERE`，`state <> $1` 不再成立 → 0 行 → 409。一个 200 一个 409，审计恰好一条。
- 一个点通过一个点驳回：第二个的 `state <> $1` 成立 → 成功（改判），两条审计，detail 的 before/after 能看出先后。
- 事务长度：UPDATE + 1 条 audit INSERT + 1 条 EnqueueTx，微秒级。

### 7.3 占额度（mail_quota 条件 upsert）

**本域最难的一条**：要同时做到「不超额度」「并发不丢」「重试不重复占」。

    -- 原生（internal/platform/mail/router.go，同一 WithTx 内）
    INSERT INTO mail_quota (account_id, day, count, updated_at)
    VALUES ($1, ($2::timestamptz AT TIME ZONE $3)::date, 1, now())
    ON CONFLICT (account_id, day) DO UPDATE
       SET count = mail_quota.count + 1,
           updated_at = now()
     WHERE mail_quota.count < $4;      -- $4 = mail_accounts.daily_limit
    -- RowsAffected = 0 → 该账号今天额度已满，换下一个；= 1 → 占用成功

- 冲突路径走 `mail_quota_pkey (account_id, day)`。`ON CONFLICT ... DO UPDATE ... WHERE` 是 PG 的**条件 upsert**：额度满时不写任何行、返回 0 行。它**单语句原子**，没有「先 SELECT 再判断」的 TOCTOU 窗口 —— 这正是「30 个并发只成功 5 次」的保证（§10 第 47 条）。
- `day` **在 SQL 里算**（`AT TIME ZONE reset_tz`），不由 Go 传日期：读回时的「同一天」判定（§7.4）必须用同一个表达式，两处不一致会让「重试恰好跨过账号午夜」误判。
- 外层（同一事务）：先 `SELECT ... FROM mail_accounts WHERE enabled AND archived_at IS NULL AND name <> ALL($exclude_names) ORDER BY priority DESC, id` 取候选。`mail_accounts` 只有几行 → **Seq Scan 是最优计划**，不给它建索引（写在这里免得有人补一个 5 行表的索引）。
- 失败即不占：若后续 `saveQuotaBinding` 失败，整个事务回滚，`count` 也不会加 1。

### 7.4 「复用已占额度」判定（读）

    -- 原生：LoadMailLog
    SELECT l.id, l.status, l.attempts, l.template, l.payload, l.to_address,
           l.quota_account_id, l.quota_day, a.reset_tz,
           (l.quota_day = ($1::timestamptz AT TIME ZONE a.reset_tz)::date) AS quota_is_today
      FROM mail_logs l
      LEFT JOIN mail_accounts a ON a.id = l.quota_account_id
     WHERE l.id = $2;
    -- 走 mail_logs_pkey（1 行）+ mail_accounts_pkey（1 行）

    -- 复用分支：不占额度，直接取账号（含密文，由 Router 解密）
    SELECT id, name, provider, priority, daily_limit, reset_tz,
           from_address, from_name, options_json, secret_cipher, secret_nonce
      FROM mail_accounts
     WHERE id = $1 AND enabled AND archived_at IS NULL;
    -- 走 mail_accounts_pkey（1 行）；0 行（账号被停用/删除）→ 当作「未占额度」重新 Acquire

`quota_is_today = false`（跨过了账号午夜）或账号已停用 → 走新占路径，`count` 在新的一天加 1（本来就该加 1）。

### 7.5 核验队列（游标分页）

ent：

    q := tx.DonationRecord.Query().Where(donationrecord.StateEQ(state))
    if cur != nil {
        q = q.Where(donationrecord.Or(
            donationrecord.CreatedAtLT(cur.Time),
            donationrecord.And(donationrecord.CreatedAtEQ(cur.Time), donationrecord.IDLT(cur.ID)),
        ))
    }
    rows, err := q.Order(ent.Desc(donationrecord.FieldCreatedAt), ent.Desc(donationrecord.FieldID)).
                   Limit(limit + 1).All(ctx)

生成的 SQL（`state='pending'`、`limit=20`）：

    SELECT d.* FROM donation_records d
     WHERE d.state = $1
       AND (d.created_at, d.id) < ($2, $3)        -- 第一页不带这个条件
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 21;

- 走 `idx_donation_records_queue (state, created_at DESC, id DESC)` → **Index Scan，无 Sort 节点**（索引序 = 排序列）。
- `LIMIT 21` + 丢掉多出的那 1 行 = 「到底」判定：`next_cursor = null` 当且仅当返回行数不超过 limit。
- 行构造器比较 `(a,b) < (c,d)` 等价于 `a < c OR (a = c AND b < d)`，两者都能用同一个索引；用行构造器少写一次索引键。
- `EXPLAIN` 预期：`Limit → Index Scan using idx_donation_records_queue`，`rows=21`，**与表总行数无关**。这就是排序键必须带 `id` 的原因：`created_at` 并列（同一秒插的两条）时不带 id 会翻页丢行。
- 同一模式套用到另外几处队列（只是表/索引不同）：`/me/rewards` 用 `idx_donation_records_donor`、`/admin/reports` 用 `idx_reports_queue`、`/admin/announcements` 与 `/admin/banners` 用各自的 `created_at DESC, id DESC` 索引。**排序键必须与索引列序逐字同序**，否则每个游标都在排序整张表。

### 7.6 举报队列（游标分页）

    SELECT r.* FROM reports r
     WHERE r.state = $1
       AND (r.created_at, r.id) < ($2, $3)        -- 第一页不带
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 21;
    -- idx_reports_queue (state, created_at DESC, id DESC) → Index Scan，无 Sort

**`uq_reports_once` 为什么必须是部分唯一索引**（写在这里是为了以后不要有人「顺手简化」）：

- 状态机是 `open → handled | dismissed`，**终态不可逆**（§2.2）。
- 业务上同一份内容被同一个人反复举报是**必须能发生的**：第一次举报被驳回（dismissed）之后，作者改了内容再犯，用户必须能再报一次。
- 普通 `UNIQUE (reporter_id, target_type, target_id)` 会让那条路径永久 409，而且**没有任何办法恢复**：行还在（终态行不删），唯一的补救是物理删除终态行 —— 那又违反「内容软删、留痕」的全局约定（数据库文档 §2.11）。
- 加上 `WHERE state = 'open'` 之后，唯一性只约束**活跃行**：终态行可以任意多，新的 open 行可以插入。这正是「同一人对同一对象只留一条未处理」的准确表达。
- **不加** `AND reporter_id IS NOT NULL`：`reporter_id` 已经 `NOT NULL`（举报必须有举报人），恒真谓词只会让索引谓词与语义脱节。
- 插入冲突的处理见 §6.5 第 4 条：撞索引 → 回查既有 open 行 → 返回 200。ent 拿不到「被冲突的那一行」，所以走 `ent.IsConstraintError` 判定 + 回查（只在真的重复举报时多一次查询）。原生 `ON CONFLICT DO NOTHING RETURNING` 也可以，但 `internal/report` 不在允许原生 SQL 的两个落点里。

### 7.7 按帖统计

    SELECT COALESCE(SUM(d.amount_cents), 0) AS total_cents, COUNT(*) AS n
      FROM donation_records d
      JOIN user_donation_settings rs ON rs.user_id = d.recipient_id AND rs.show_channels   = true
      JOIN user_donation_settings ds ON ds.user_id = d.donor_id     AND ds.records_public = true
     WHERE d.state = 'approved' AND d.post_id = $1;

- `post_id` 上有单列索引（外键索引）：`Index Scan using idx_donation_records_post`，`rows≈10` + 两次 `Index Only Scan`。
- 若某帖被打赏几千次（爆款），PG 会改用 `idx_donation_records_post` 再过滤 state；更优的是 `(post_id, state)` 复合索引。**现在不做**，等 EXPLAIN 显示 `rows > 1000` 再加。

### 7.8 排行榜

    SELECT d.recipient_id, u.public_id, u.nickname, u.avatar_small_hash,
           COALESCE(SUM(d.amount_cents), 0) AS total_cents,
           COUNT(*)                          AS record_count
      FROM donation_records d
      JOIN users u  ON u.id = d.recipient_id
      JOIN user_donation_settings rs ON rs.user_id = d.recipient_id AND rs.show_channels   = true
      JOIN user_donation_settings ds ON ds.user_id = d.donor_id     AND ds.records_public = true
     WHERE d.state = 'approved'
     GROUP BY d.recipient_id, u.public_id, u.nickname, u.avatar_small_hash
     ORDER BY total_cents DESC, d.recipient_id
     LIMIT $1;

**这条会全表扫描 `donation_records`，这是有意的，必须写在文档里**：

- 排行榜**在定义上**就要看全体收款人，没有任何等值条件能先缩范围。计划是 `Hash Join（两张小设置表）→ HashAggregate → Sort → Limit`。
- 可接受的前提：`donation_records` 是本站**增长最慢**的业务表（一次打赏 = 一次真金白银的动作；乐观每年几千行，悲观几万行）。几万行的 HashAggregate 是几十毫秒。
- 它**不在任何列表页热路径上**：只有管理后台的统计页调它。
- 闸门（数据库文档 §12 第 11 条）：CI 里跑 `EXPLAIN (ANALYZE, BUFFERS)`，这条**显式豁免「禁止 Seq Scan」**，但断言 `rows examined 不超过 donation_records 行数`（防笛卡尔积式爆炸）。
- 什么时候必须改：`donation_records` 超过 10 万行，或统计页 P95 超过 500ms → 加 `donation_totals` 汇总表，随核验事务维护。**现在不做**：那会引入第二份真源（汇总表与明细必然漂移），而现在没有任何证据表明需要它。

### 7.9 孤儿检查（数据库文档 §12 第 7 条，本域部分）

    SELECT 'report' AS kind, r.id
      FROM reports r
     WHERE (r.target_type = 'topic' AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = r.target_id))
        OR (r.target_type = 'post'  AND NOT EXISTS (SELECT 1 FROM posts  p WHERE p.id = r.target_id))
        OR (r.target_type = 'user'  AND NOT EXISTS (SELECT 1 FROM users  u WHERE u.id = r.target_id))
     LIMIT 100;

- 走 `idx_reports_target (target_type, target_id)` 的三次 Index Scan + 三次 PK 探测。
- **策略（否则这条检查永远红）**：`topics` / `posts` / `users` 都**不物理删除**（全局约定 §2.11），所以正常结果恒为空；真出现孤儿（手工 SQL、导入脚本）**不清理、不隐藏** —— 举报是证据，内容没了举报还在，正确。检查的目的是报警，不是删行。
- 因此它在 `forum check` 里是 **Warn**，不是启动失败项。CI 用一份负例夹具证明它真会红（§10 第 26 条）。

### 7.10 生效中的横幅

ent：

    bq := tx.Banner.Query().Where(
        banner.Enabled(true),
        banner.StartsAtLTE(now),
        banner.Or(banner.EndsAtIsNil(), banner.EndsAtGT(now)),
    )
    if actor != nil {
        bq = bq.Where(banner.Or(
            banner.Not(banner.HasRoles()),
            banner.HasRolesWith(bannerrole.RoleIDEQ(actor.RoleID)),
        ))
        bq = bq.Where(banner.Not(banner.HasDismissalsWith(bannerdismissal.UserIDEQ(actor.UserID))))
    } else {
        bq = bq.Where(banner.Not(banner.HasRoles()))
    }
    rows, err := bq.Order(ent.Asc(banner.FieldID)).Limit(5).All(ctx)

生成的 SQL（登录用户；`Not(HasX)` → `NOT EXISTS`）：

    SELECT b.* FROM banners b
     WHERE b.enabled
       AND b.starts_at <= now()
       AND (b.ends_at IS NULL OR b.ends_at > now())
       AND (NOT EXISTS (SELECT 1 FROM banner_roles br WHERE br.banner_id = b.id)
            OR EXISTS (SELECT 1 FROM banner_roles br
                        WHERE br.banner_id = b.id AND br.role_id = $1))
       AND NOT EXISTS (SELECT 1 FROM banner_dismissals bd
                        WHERE bd.banner_id = b.id AND bd.user_id = $2)
     ORDER BY b.id
     LIMIT 5;

- 主表：`idx_banners_active (starts_at, ends_at) WHERE enabled` —— 查询谓词与索引谓词逐字一致 → **Index Scan**。`banners` 只有几十行，退化也无所谓，但既然有部分索引就让谓词对齐。
- `banner_roles`：`banner_roles_pkey (banner_id, role_id)` 服务第一个 `EXISTS`；第二个用 `idx_banner_roles_role` 或 PK 都行（两个方向都有索引）。
- `banner_dismissals`：PK `(banner_id, user_id)` 正好覆盖这个 `NOT EXISTS`；`uq_banner_dismissals_user (user_id, banner_id)` 是给反向查询与级联删除用的。**两个索引都在是有意的**，PG 的外键索引自检只要求「有一个可用的非部分索引」。
- **用 `NOT EXISTS` 而不是 `LEFT JOIN ... IS NULL`**：后者在有多个匹配行时会把同一条横幅复制多份，必须在外面再 `DISTINCT`。横幅最多 5 条，半连接短路更快也不容易写错。
- **不做缓存**：成本是微秒级（几十行的表 + 三次索引探测），而缓存它要引入「发布横幅后最多 30 秒不可见」的困惑 —— 管理员发布后的第一件事就是刷新看效果。

### 7.11 横幅 dismiss（幂等）

    INSERT INTO banner_dismissals (banner_id, user_id)
    VALUES ($1, $2)
    ON CONFLICT (banner_id, user_id) DO NOTHING;

- 冲突走 `banner_dismissals_pkey`，重复点永远 204。
- 写之前先 `SELECT 1 FROM banners WHERE public_id = $1` 校验存在：不存在 → 404，而不是让外键冲突报 500。

### 7.12 site_settings upsert（批量，事务内）

    INSERT INTO site_settings (key, value, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

- 一个 key 一次循环，冲突走 `site_settings_pkey`。10 个 key 就是 10 次单行 upsert（微秒级）；拼成多值 `VALUES` 要配 `unnest`，可读性下降而收益为零。
- 审计的 before 在同一事务内 `SELECT value FROM site_settings WHERE key = $1` 读：整段持有这些行的写锁，读到的旧值就是真正的旧值，不存在 TOCTOU。

### 7.13 站点设置读（缓存未命中）

    SELECT key, value FROM site_settings;

- 10 行，**Seq Scan 是正确计划**。结果整体进内存缓存（§8.1），不是每请求查一次。

### 7.14 公告（首页 3 条）

    SELECT a.id, a.public_id, a.title, a.body_html, a.published_at
      FROM announcements a
     WHERE a.enabled AND a.published_at IS NOT NULL
     ORDER BY a.published_at DESC, a.id DESC
     LIMIT 3;

- `idx_announcements_published (published_at DESC, id DESC) WHERE enabled AND published_at IS NOT NULL` → **Index Scan，无 Sort**。查询谓词必须能推出索引谓词，这就是部分索引的正确用法。
- 后台列表（含草稿）没有可用谓词 → Seq Scan（几十行，正确）。

---

## 8. 缓存与并发

### 8.1 站点设置缓存（进程内）

    type settingsCache struct {
        mu     sync.RWMutex
        vals   map[string]string
        loaded time.Time
    }
    // Load：TTL 内直接返回 map（调用方只读）；过期则重新 SELECT 整表
    // Invalidate：把 loaded 置零，下次读重新加载

- TTL 30 秒（后台改完主动失效，TTL 只是兜底：多实例或漏调时最多脏 30 秒）。
- 粒度是**整表**（10 行），不做按 key 失效 —— 按 key 失效需要一个映射表，而整表重载的成本是「一次 10 行的 Seq Scan」，每 30 秒一次。
- 缓存存的是 DB 原值，**默认值的回落在 `Lookup(key)` 里做**（取 `spec.Default`）：否则「表里没有这行」与「值是默认值」在缓存里长得一样。
- 不引第三方 LRU：条目数 = key 数（10），一个 mutex + time.Time 就够（`性能与容量.md` §4 的「缓存必须有硬上限」在这里天然满足）。

### 8.2 账号列表缓存（`platform/mail.Router`）

- TTL 30 秒，内容 = `[]Account`（含**解密后的** secret）。内存里持有明文凭据的时间就是 TTL —— 这是必然代价（每次发信都解密没有安全收益，只多一次 chacha20 的开销）；**禁止把 Account 写进任何日志/审计/响应**。
- 后台任一写操作（create/update/delete/test）→ `Router.Invalidate()`。
- `mail_quota` **永不缓存**（它是账）。
- 条目数 = 账号数（个位数），不需要 LRU 淘汰。

### 8.3 并发下会发生什么（逐条）

| 场景 | 结果 | 数据停在哪 |
|---|---|---|
| 两个管理员同时核验同一条 pending，都点「通过」 | 一个 200、一个 **409 already_handled**；**审计恰好一条** | approved |
| 一个点通过一个点驳回 | 两个都成功（第二个是改判），两条审计 | 后提交者的状态 |
| 用户双击「撤回」 | 第一次成功；第二次 204（幂等） | withdrawn |
| 用户双击「举报」 | 第二次 200 + 同一行 | 一条 open |
| 管理员双击「批量核验」 | 第二次整批逐条 409 already_handled | 不变 |
| 队列崩溃恢复导致同一 `mail:send` 重跑 | `FOR UPDATE SKIP LOCKED` 保证同一时刻只有一个 worker 持有；但「发完信、还没记 sent 就被 SIGKILL」会**再发一封** | 见 §8.4 |
| 同一 MailLog 重试 3 次 | 只有第一次 `Acquire` 占额度（`quota_day` 命中 → 复用） | 额度 = 1 |
| 重试跨过账号 reset_tz 的午夜 | `quota_day` 不等于今天 → 重新 `Acquire`（可能换账号），新的一天加 1 | 新一天额度 = 1 |
| 30 个 worker 抢同一个账号最后 5 个额度 | 条件 upsert 原子判定：恰好 5 次 RowsAffected=1 | 不超卖 |
| 后台改账号时正在发信 | 旧 Account（含旧 secret）最多再用 30 秒；Invalidate 只影响下一次 Acquire | 无损坏 |
| 后台改完设置，另一个请求同时读 | 读到的还是旧值（缓存），写方提交后 Invalidate → 下一次读新值 | 最多脏一个请求 |

### 8.4 失败恢复

| 失败 | 数据状态 | 要人修吗 |
|---|---|---|
| 核验事务里 queue 入队失败 | 整个事务回滚（EnqueueTx 与业务同事务）→ 核验没发生 | 不要 |
| 核验成功、notify 任务最终 dead | 状态与审计都正确，只是没发通知 | 不要（通知是尽力而为） |
| `mail:send` 渲染失败 | `mail_logs.status='failed'` + error | 要（模板缺字段 = 代码 bug）；自检面板显示 failed 计数 |
| 所有账号 `ErrPermanent` | 每条 mail_log 各自 failed；`last_error` 在账号上 | 要（管理员改账号） |
| 主密钥换了但没配 OldKeysHex | 账号解不开 → 每次 Acquire 都跳过 → ErrNoProvider → 邮件积压 pending 并排到明天 | 要（补 OldKeysHex 重启）；启动 Warn + `forum check` Error |
| 进程在「占额度、发信」之间挂掉 | 额度白占一次，mail_logs 停在 pending，恢复后重跑（复用已占额度） | 不要（v2 §8.3：一次性损耗接受） |
| 发信成功但写库前崩溃 | 重试会**再发一封**（SMTP 没有幂等键） | 不要；这是盲审 B2 的剩余窗口，只有 provider 支持 Idempotency-Key 时才没有它 |

---

## 9. 错误码

只列**本域新增**的（对照 §21.4 总表；不新增就不造）：

| code | 状态 | 出现场景 | 备注 |
|---|---|---|---|
| `reward.already_handled` | 409 | 核验到一个已经是目标态的申报；批量结果里也用它 | 总表已有 |
| `reward.invalid_transition` | 409 | 核验一条 withdrawn 的行 | **新增** |
| `reward.disabled` | 403 | donation.enabled = off 时提交申报 / 读收款码 | **新增** |
| `report.already_handled` | 409 | 处理一条已经 handled/dismissed 的举报 | **新增** |
| `site.unknown_setting` | 400 | PATCH site-settings 里出现未知 key | **新增**（带 fields；也可直接用 common.invalid_input，见 U6） |
| `site.bad_url` | 400 | 横幅 url 不是 http/https 或站内相对路径 | **新增** |
| `mail.no_account` | 503 | 一个可用发信账号都没有，且调用方需要立刻知道（管理端测试发信） | **新增**；业务投递不用它（业务走队列，返回 202） |
| `mail.secret_undecryptable` | 500 | 管理端测试发信时该账号凭据解不开（主密钥不对） | **新增**；不对外说细节，细节进日志 |

复用总表：`common.invalid_input`（+fields）、`common.unauthorized`、`common.forbidden`、`common.not_found`、`common.conflict`、`common.rate_limited`、`common.internal`。

**明确不新增**：`reward.not_found` / `report.not_found`（用 common.not_found）；`report.duplicate`（重复举报是 200，不是错误）；`mail.quota_exceeded`（额度用尽是内部流转，用户看不到 —— 它表现为「邮件晚到」）。

---

## 10. 测试清单

数据库用真 PG（embedded-postgres 显式随机端口 + 每用例独立 schema，拍板 §5.8）。

**reward**

1. 申报正常路径：`POST /rewards` → 201；一行 `state='pending'`、`public_id` 是 v7、`verified_by IS NULL`。
2. 申报给自己 → 400，**且 count 不变**。
3. `amount_cents` = 0 / 负 / 超上限 → 400（binding）。
4. `donation.enabled=off` → 403 `reward.disabled`。
5. 撤自己 pending → 204 → `withdrawn`；**再撤一次 → 204**。
6. 撤别人的 → 404；撤自己的 approved → 403。
7. `GET /users/{handle}/channels`：`show_channels=false` → `data: []`（**空数组，不是 null**）；`true` → 返回收款码且 `image` 形如 `/img/<hash>`。
8. `GET /users/{handle}/rewards`：造 4 条 approved（两公开两私有）+ 1 条 pending → 只返回 2 条；游客也能看。
9. 核验幂等：pending → approved（200）；**再核一次同一目标态 → 409**；断言 `verified_at` 未被改写、审计**只有一条**。
10. 改判：approved → rejected → 200；审计**两条**，第二条 detail.before = approved。
11. withdrawn → approved → 409 `reward.invalid_transition`。
12. **并发同态**：两个 goroutine 同时对同一条 pending 用同一目标态核验 → 一个 200 一个 409；审计恰好一条；state 恰好等于目标态。（真连接并发，不用 mock）
13. **并发异态**：一个 approved 一个 rejected → 成功次数 == 审计条数，最终 state 属于 {approved, rejected}。
14. 批量：10 条里 3 条已 approved → results 10 项、7 ok、3 个 already_handled；成功的确实改了，3 条未动。
15. 批量事务性：把 EnqueueTx 换成必然报错的 fake → 断言整批回滚（0 条改变）。
16. 统计：4 条 approved（两公开两私有）+ 2 条 pending → 用户侧合计 = 两条公开之和；管理侧 `public_total_cents` 同上、`all_total_cents` = 四条之和。
17. 分页：25 条 pending，`limit=21` → 第一页 21 + cursor；第二页 4 + `next_cursor=null`；两页 id 不相交。
18. `GET/PATCH /me/donation-settings` 默认值：`show_channels=false, records_public=false, notice_visible=true, notice_text=''`（旧站默认就是关）。
19. notice-defaults 整表替换：传 1 条 → 表里只剩 1 行。

**report**

20. 举报不存在的内容 → 404；比自己 → 400。
21. 重复举报 → **200** + 同一条 `public_id`；表里只有一行 open。
22. **驳回后再举报 → 成功**（`uq_reports_once` 的部分谓词生效）—— 这是那个索引存在的理由，必须有。
23. 处理：open → handled，`handler_id` / `handled_at` 非空；handled 不写 note → 400；dismissed 不写 note → 200。
24. **并发**处理同一条 → 一个 200 一个 409；审计一条。
25. 终态再处理 → 409 `report.already_handled`。
26. 孤儿检查用**负例夹具**：手工 `DELETE FROM posts WHERE id=…`（绕过应用）→ §7.9 返回 1 行（证明它会红）。

**site**

27. `GET /site` 游客：只返回无定向的生效横幅；定向横幅对游客不可见。
28. 生效窗口三种不可见：`starts_at` 在未来 / `ends_at` 在过去 / `enabled=false`（各一条）。
29. dismiss 幂等：连点 3 次都 204，表里 1 行；之后 `GET /site` 不再包含它。
30. `PATCH /admin/site-settings` 未知 key → 400，fields 里有它，**且 DB 无任何写入**（断言 `updated_at` 未变）。
31. 已知 key 非法值（`registration.open='yes'`）→ 400；合法值 → 200 且缓存**立刻**反映新值（测 Invalidate）。
32. 缓存 TTL：绕过 service 改库 → 30 秒内读旧值、之后新值（`clock.Fake`）。
33. 横幅 url：`javascript:alert(1)` → 400；`//evil.com` → 400；`https://…` 与 `/topics/1` → 200。
34. 公告：草稿不出现在 `GET /site`；`enabled=false` 也不出现；`<script>` 被清洗掉。
35. `RegisterBaseDomain` 幂等（连调两次 1 行）；base_url 为空只 Warn 不报错。

**mail**

36. 加解密往返 OK；**AAD 绑错账号名 → 解不开**（把密文搬到另一个账号 → 失败）。
37. 主密钥非法/缺失 → `forum run` **启动失败**。
38. 账号 CRUD 不回凭据：`GET /admin/mail/accounts` 的响应 JSON 里不出现 `secret` 子串；PATCH 不带 secret 时 `secret_cipher` 字节不变。
39. 额度轮换：`daily_limit=2` 的账号发 3 封 → 第 3 封落到下一个账号（fake provider 记录收到的账号）。
40. **同一 MailLog 重试 3 次只占 1 次额度**：provider 前两次 `ErrTemporary`、第三次成功 → `mail_quota.count == 1`、`status='sent'`、`attempts=3`。
41. `status='sent'` 的任务重复执行 → provider **未被调用**（调用计数 0），返回 nil。
42. `ErrQuotaExceeded` → 熔断该账号 → 落到下一个；该账号当天 `count` 被设为 `daily_limit`（不是加 1）。
43. `ErrPermanent` → `status='failed'`、返回 `queue.ErrSkipRetry`、**不换账号**（fake 只被调一次）。
44. `ErrNoProvider` → mail_logs 停在 pending、attempts+1，队列里出现一条 `run_at ≈ 明天 00:35` 的同 payload 任务；**没有**进 dead。
45. 零账号：启动只 Warn；任务失败可重试；后台建号后**不重启**即可发信（缓存失效）。
46. `mail.enabled=off` → 直接 failed + SkipRetry，provider 未被调用。
47. **并发不超卖**：`daily_limit=5`，30 个 goroutine 同时 `Router.Acquire` → `NewlyHeld=true` 恰好 5 次，`count == 5`。
48. 崩溃恢复：手工把 `locked_until` 改到过去 → 恢复循环捡回 → 重跑不会重复发（`status='sent'` 短路）。
49. 模板：`template` 常量集合 == 文件名集合 == CHECK 值域；缺任一 `.html.tmpl` / `.txt.tmpl` 启动失败；渲染结果里没有未替换的 `{{`。

**跨域 / 契约**

50. 权限：普通用户调 `/admin/rewards*` → 403；持 `reward.verify` → 200；持 `report.handle` 调 `/admin/rewards` → 403（权限点不串）。
51. service 兜底：直接调 `Service.Verify(ctx, 普通用户 actor, …)` → Require 报错（不走路由也挡住）。
52. `nil actor` 传给 Verify → 返回错误而不是 panic。
53. **SettingSpecs 与前端 mock 键一致**：测试读 `web/src/devroom/pages/15-admin/mock/system.ts` 里所有 `key:` 并与 `SettingSpecs()` 比对，缺一即失败（防两处漂移）。
54. **模板常量、文件、CHECK** 三者一致（同 49，作为独立自检项）。
55. 契约测试（§21.6）：本域 35 个端点各发一次真实请求（成功 + 400 + 401 + 403 + 404），响应体用前端 zod schema 解析。
56. 迁移测试：空库 → 全部迁移 → 断言 13 张表存在、`uq_reports_once` 的 `indexdef` 含 `WHERE (state = 'open')`、`uq_mail_logs_idem` 存在、全部 `ck_` 约束存在（用 psql 断言，不用 Atlas diff —— 盲审 §4 已定口径）。
57. 外键索引自检（数据库文档 §12 第 1 条）：本域全部表跑那条 SQL，结果必须为空（重点：`banner_roles.role_id`、`banner_dismissals.user_id`、`mail_logs.quota_account_id`、`donation_records.post_id / channel_id / verified_by`、`reports.handler_id`、`announcements.created_by`、`banners.created_by`）。
58. 慢查询闸门：对 §7.1 / §7.5 / §7.6 / §7.14 跑 `EXPLAIN (ANALYZE, BUFFERS)`，断言**没有 Seq Scan**（表少于 1000 行豁免）；§7.8 显式豁免。

---

## 11. 四个必答问题

### 11.1 数据量上来还走索引吗？（EXPLAIN 预期）

| 查询 | 索引 | 预期计划 | 预期行数 |
|---|---|---|---|
| §7.5 核验队列第 1 页 | idx_donation_records_queue | `Limit → Index Scan`（**无 Sort**） | 21（与表总量无关） |
| §7.5 第 N 页 | 同上 | `Index Cond: (state = $1 AND (created_at,id) < ($2,$3))` | 1 |
| §7.6 举报队列 | idx_reports_queue | `Limit → Index Scan`（无 Sort） | 21 / 1 |
| §7.1 收入侧合计 | idx_donation_records_recipient | `Index Scan` + 2x `Index Only Scan` | 该收款人的 approved 行数 |
| §7.7 按帖统计 | idx_donation_records_post | `Index Scan` + 2x `Index Only Scan` | 该帖的打赏数 |
| §7.2 核验 CAS | donation_records_public_id_key | `Update → Index Scan` | 1 |
| §7.3 占额度 | mail_quota_pkey | `Insert → Conflict Update → Index Scan` | 1 |
| §7.4 复用判定 | mail_logs_pkey / mail_accounts_pkey | `Index Scan` | 1 |
| §7.10 生效横幅 | idx_banners_active | `Index Scan` + 半连接 | 不超过 5 |
| §7.14 公告 3 条 | idx_announcements_published | `Limit → Index Scan`（无 Sort） | 3 |
| §7.8 排行榜 | 无（全表聚合） | `HashAggregate → Sort → Limit`，**含 Seq Scan** | 全表 |

**唯一随数据量变坏的是 §7.8**，它是有意为之，并写了触发升级的阈值与做法。其余每条都是「O(返回行数)」，与表总量无关。

### 11.2 并发重放会发生什么

见 §8.3（两个管理员、双击提交、任务重试两次、跨午夜、额度竞争，逐条给结论）。摘要：**所有写路径都靠条件 UPDATE / 条件 upsert 收敛，没有「先读再写」的窗口**；重复请求要么 409（核验、处理），要么 200 + 同一行（举报、dismiss、撤回），**没有一种情况会写第二行或第二个状态**。

### 11.3 失败之后数据停在哪？要人修吗

见 §8.4。摘要：核验/处理类失败 = 事务整体回滚，停在操作前（**不要人修**）；邮件类失败 = `mail_logs.status='failed'` + 账号上的 `last_error`（**要人看**，自检面板显示失败计数）；主密钥配错 = 邮件积压 pending 并排到明天（**要人修**，启动 Warn + `forum check` Error）。

### 11.4 这段代码不写会少什么

| 若不写 | 少什么 | 结论 |
|---|---|---|
| `uq_reports_once` 的部分谓词 | 被驳回后永久不能再举报（§7.6） | **必须** |
| CAS 的 `state <> $1` | 重复核验写第二份审计，「改判」与「重放」在追责时无法区分 | **必须** |
| `mail_logs.quota_day` | 「一次投递占一次额度」无法实现（重试会重复占） | **必须** |
| `mail_quota` 的条件 upsert | 额度会超卖（并发 SELECT-then-UPDATE） | **必须** |
| `uq_banner_dismissals_user` | 级联删除 user 时全表扫 dismissals（PG 不自动建 FK 索引） | **必须** |
| §7.10 的四个 `EXISTS` / `NOT EXISTS` | 定向与「不再显示」失效（最典型的运营 bug：关不掉的横幅） | **必须** |
| notice-defaults 的整表替换语义 | 后台删不掉一行默认文案（只能改成空串，表里留垃圾） | **必须** |
| site_settings 按 key 一条审计 | 改动的起因查不出来（谁把注册关了） | **必须** |
| `announcements.enabled` | 草稿只能靠物理删除（迁移里的 DELETE 不可逆） | **必须** |
| `site_domains.is_primary` | 目前没有任何代码读它；真源是 base_url | **删掉**（§3.2 已删，见 U2） |
| `reports.detail` | 举报人补充说明无处可放（界面已按 reason+detail 两栏做了） | 保留（一列，零成本） |
| `mail_accounts.archived_at` | 「被历史 MailLog 引用时只允许停用」无法与「管理员主动停用」区分 | 保留 |
| `mail_logs.attempts` | 排查「发了几次」只能数日志 | 保留 |
| `donation_records.channel_id` | 核验时不知道对方扫的是哪张码（多码作者无法对账） | 保留（可空一列） |

---

## 12. 明确不做（本域）

| 不做 | 理由 |
|---|---|
| 支付 Gateway / 回调 / 签名校验 / 主动查单 / 对账 / Wallet / Ledger / 余额 | 拍板 §6 定案；站点不经手资金 |
| 「已支付 / 已结算 / 已退款」三个状态 | v2 §12.3：不要发明这些状态 |
| 举报自动处置（自动封号 / 自动隐藏） | 与 `user.ban` 是不同权限点；自动处置的误伤不可逆 |
| 举报工单重开（handled 回到 open） | 再报一次更简单，且 `uq_reports_once` 允许 |
| 横幅按用户组定向 | 拍板：定向用角色（`banner_roles`） |
| 横幅缓存 | §7.10：成本微秒级，缓存只带来「发布后 30 秒不可见」的困惑 |
| site_settings 的按 key 缓存失效 | 整表 10 行，重载成本可忽略 |
| 站点设置的后台可增删 key | 代码表（`SettingSpecs()`）是唯一真源；新增 key = 改代码 + 迁移默认值 |
| `site_domains` 的写端点 | 改主域名牵动 Cookie/CSRF（界面需求 §5.11 定案）；v1 只读 + 启动自动登记 |
| 邮件摘要合并（digest） | v2 §8.4 允许但无需求；不做就没有「摘要状态机」 |
| 管理端「重发邮件」按钮 | 用户侧已有「重新发送验证邮件」；管理端重发要先定「新幂等键还是复用」 |
| Redis 存额度 | v2 §7.1：邮件额度必须持久化，禁止放内存 |
| `mail_logs` 的清理任务 | `(status, created_at DESC)` 够用；等表大了按 created_at 归档（清理期见 U8） |

---

## 13. 未决问题

见 `d6-reward-交接.md` §4。

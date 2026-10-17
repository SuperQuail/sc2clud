# 管理后台功能对照表（老站 13.1–13.15 → 本次 DevRoom 页面）

> 本文件是 **W5（15-admin 页）** 的第一步交付：把《原项目功能清单》第 13 章「管理后台」逐条对着
> 《论坛后端技术方案-v2》§9.8 / §20.4 D6 / §21.2 与《RBAC权限树设计.md》落成一张表，
> 再决定「在哪一屏做 / 为什么不做」。**13.1–13.15 一条不跳。**
>
> 页面 key：`15-admin`；代码在 `web/src/devroom/pages/15-admin/`。
> 本页是**设计验证页**：全部数据是页面内的 mock（`mock/*.ts`），不 fetch、不接 api client。
> 权限：`mock/perms.ts` 做 `useCan(perm)` 语义的本地 mock —— **前端权限只决定显不显示，真正的判定在后端**（前端方案 §5.4）。

## 0. 后台骨架（13.1 的落点）

| 骨架要素 | 实现位置 |
|---|---|
| 左侧分组导航（用户与权限 / 内容 / 运营 / 系统） | `shell.tsx` 的 `NAV` + `AdminShell` |
| 中栏列表 | 各屏的 `DataTable`（`data-table.tsx`，待提升为 `src/ui`） |
| 右栏详情 / 就地操作 | 各屏右侧 `DetailPanel`；列表宽屏时用「就地操作」列 |
| 顶部面包屑 + 当前管理员（含追加权限入口） | `shell.tsx`：Breadcrumbs + UserBadge + 「权限明细」 |
| 危险动作二次确认 | `confirm.tsx` 的 `ConfirmDialog`（Ring UI Dialog）+ `DisabledReason` |

## 1. 逐条对照（13.1–13.15）

| 老功能 | 现状（新方案里的对应物） | 在哪一屏做 / 为什么不做 |
|---|---|---|
| **13.1 管理面板入口与总览**（侧栏 / 分页签 / 搜索登录名） | 前端方案 §6 路由表 `/admin/*`（各自权限点）；§21.2 admin 端点总表 | **做**：`shell.tsx` 后台骨架（分组导航 + 面包屑 + 当前管理员）。「总览页」不做独立屏：`/admin/*` 各屏自带统计条（各屏顶部 `StatRow`），多一个空总览页只是多点一次 |
| **13.2 用户管理**（新建 / 编辑 / 改名 / 激活 / 停用 / 改角色 / 分配配额 / 激活策略） | §21.2 `GET /admin/users`（`user.ban` 或 `role.assign`）、`PATCH /admin/users/{id}`（`user.ban`）、`POST/DELETE /admin/users/{id}/roles`（`role.assign`）；DB §4.1 三根状态轴（`status` / `email_verified_at` / `activated_at`） | **做（核心屏 a）**：`screens/users.tsx` —— 搜索（登录名/昵称/邮箱）、行内激活/停用、发头衔（`title.grant`）、批量选择、右栏三轴 + 追加权限 + 处罚。<br>· `username` 不可改（DB §4.1 不变量）→ 详情里只读显示；<br>· **磁盘配额不做**：D2 已定案放弃网盘，`quota_bytes/used_bytes` 不迁；<br>· 「改角色」按钮在本账号下**不渲染**（mock 未持有 `role.assign`）——这正是 9.8「`role.edit` 与 `role.assign` 必须分成两个权限点」的演示 |
| **13.3 帖子审核队列**（通过 / 拒绝 / 归档 / 取消归档 / 请求修改） | 清单 B2：`topics.status` 的 `pending`/`rejected`（DB §4.2）；§21.2 **没有** admin 侧审核端点 | **做（核心屏 d）**：`screens/review.tsx` —— 待审/已通过/已拒绝 Tab、批量通过/拒绝、右栏看原文、请求修改（写备注）。<br>· 「归档」并入状态机：`hidden` 不做独立按钮（DB 里没有 archived 的帖子状态）；<br>· 端点/权限点缺口见回报「明确的后端需求变动」 |
| **13.4 内容与站点设置**（分区排序 / 封面 / 分区发言权限 ACL / 默认文案 / 默认头像池 / 域名白名单） | §20.4 **D6**：`boards.acl_enabled` + `board_acls`（DB §4.2）；§21.2 `GET/POST/PATCH /admin/boards[/{id}]`、`PUT /admin/boards/{id}/acl` | **做**：分区拆到 `screens/boards.tsx`（排序、封面、`acl_enabled`、角色×分区矩阵），站点文案拆到 `screens/settings.tsx`。<br>· 默认头像池：`site_settings` 键值即可承载，不单独做屏；<br>· 域名白名单：`site_domains` 表在 DB §4.9 里，但 §21.2 无端点 → 本页只做只读展示 + 列入后端需求 |
| **13.5 用户组管理**（建组 / 改组 / 归档 / 设成员；组 × 分区允许与禁止） | **D6：不再有「用户组」这第二个主体**，自定义角色就是原用户组；作用域规则落在 `board_acls`（`can_post/can_reply/deny_post/deny_reply`），分区级最低角色被「允许哪几个角色」替代（9.8 禁止用优先级比大小） | **做（核心屏 b + c）**：`screens/roles.tsx`（角色树 + 权限矩阵 + 影响预览）、`screens/boards.tsx`（角色×分区 ACL，禁止优先的视觉表达）。<br>· 「组」这个名词在本项目**不存在**：角色树即组，不再做第二张表 |
| **13.6 头衔目录管理 + 给用户发头衔** | §21.2 `GET/POST/PATCH /admin/titles[/{id}]`（`title.manage`）、`POST/DELETE /admin/users/{id}/titles/{titleId}`（`title.grant`）；DB §4.11 `titles` / `user_titles` / `users.equipped_title_id` | **做**：`screens/titles.tsx`（目录列表 + 归档而非删除）与 `screens/users.tsx` 的「发头衔」对话框。<br>· 等级/经验（`users.exp/level`）不在本页：它由发帖/回复自动增长，管理员没有手改入口（DB §4.11 只给公式） |
| **13.7 处罚：封号 / 解封 / 限期禁言（禁发帖 / 禁评论 × 全局 / 指定分区 × 到期）** | §21.2 `POST /admin/users/{id}/sanctions`（`user.ban`）；DB §4.1 `users.status` 是封禁轴 | **做**：`screens/users.tsx` 的停用/解封（危险动作 + 二次确认）与右栏处罚记录（含分区维度的限期禁言、到期时间）。<br>· 分区级禁言的服务端命中在 D6 判定顺序第 2 步（有 Sanction 命中 → 拒绝） |
| **13.8 打赏审核队列**（待审 / 通过 / 拒绝 / 结算） | D3 已定案走老设计；DB §4.6 `donation_records`（`pending/approved/rejected/withdrawn`、`amount_cents` 整数分、`verified_by/verified_at`）；§21.2 `GET /admin/rewards`、`POST /admin/rewards/{id}/verify` | **做（核心屏 f）**：`screens/rewards.tsx` —— 四个状态 Tab、批量核验、收款码查看、改判留痕提示、只算 approved 且公开的统计条。<br>· 「结算」不做按钮：站点不经手资金（12.8 硬约束），没有余额/流水可结 |
| **13.9 发信账号管理**（多账号 / 优先级 / 日额度 / 启用归档 / 测试发信 / 凭据加密 / 轮换冷却） | §8.2 + DB §4.8 `mail_accounts`（`priority/daily_limit/secret_cipher/...`）、`mail_quota`；§21.2 `GET/POST/PATCH/DELETE /admin/mail/accounts[/{id}]` + `/test`（`mail.manage`） | **做**：`screens/mail.tsx` —— 账号表（优先级 / 日额度与今日已发 / 启用开关 / 最近成功与失败）、测试发信、归档。<br>· 凭据只显示「已配置 / 未配置 + 更新时间」（`secret_cipher` 只写不回读），轮换密钥属超管级 → 本账号不渲染 |
| **13.10 AI 审核**（配置 / 密钥 / 连通性测试 / 手动触发 / 留痕） | **做**（2026-10-14 补，权威设计 `完全重构/后端设计/d7-ai-review.md`）：后端 `forum/internal/aireview` + 迁移 0020/0021 + 四个 admin 端点（`GET/PATCH /admin/ai/config`、`POST /admin/ai/config/secret`、`POST /admin/ai/test`，权限点 `site.setting`）+ 发帖事务投 `ai:review`（无 key 时零外呼、帖留 pending） | **做**：`screens/ai-review.tsx`（已登记进 `registry.ts` 的 `admin-ai-review`）。<br>· 这一行原先写的是「**不做**：方案没有 AI 审核模块，9.5 明确自建、不依赖外部服务」—— 那句在**写下当天是对的**（当时确实拍板不做外部 AI），后来产品改主意、d7 落地，它就成了假话：`nav.ts` / `index.tsx` / `routes/admin.tsx` 都挂着 `ai` 屏，交接单 §4.H 也已按「要做」排期。<br>· 密钥**只写不回显**（GET 只给 `has_secret` / `secret_updated_at`）；本屏 mock 里的关键词判定不是真判定，真实判定全由模型做（接线见交接单 H2） |
| **13.11 数据备份**（备份页 / 创建备份 / 下载备份） | DB §8 备份与恢复；方案 §16 已覆盖（服务端 cron + 快照） | **不做**：备份是**服务端运维动作**（DB §8 的 pg_dump + 快照），不是业务后台的一个按钮；页面上放一个能触发备份的按钮等于把运维权限开给管理员。本页只在 `screens/diagnostics.tsx` 只读展示「最近备份时间」 |
| **13.12 自检面板**（`/debug`，debug 开关门控） | §21.2 `GET /admin/diagnostics`（`site.setting` **且 debug 开关打开**）；后端 §9.8 权限点一致性自检、DB §12 一致性自检 | **做**：`screens/diagnostics.tsx` —— 只读结果列表（权限点集合一致性、迁移版本、计数列校准、搜索索引延迟）+ debug 关闭时的空态 |
| **13.13 审计日志**（actor / action / target / detail；个人变动日志页） | DB §4.1 `audit_logs`（`actor_id/action/target_type/target_id/detail jsonb/ip`）；§21.2 `GET /admin/audit-logs`（`audit.view`）；9.8「提权类操作必须写审计」 | **做**：`screens/audit.tsx` —— 按操作者 / 目标类型 / 动作前缀 / 时间过滤的日志表 + 提权类高亮。<br>· 「个人变动日志页」不在本页（属于个人设置屏），本页只做管理侧全域查询 |
| **13.14 站点域名统一管理**（哪些域名算「自己」，启动时登记 base_url） | DB §4.9 `site_domains`（`is_primary` 部分唯一索引）；清单 B15；§21.2 **无端点** | **部分做**：`screens/settings.tsx` 里只读展示域名表 + 主域名标记；**写入不做**（没有端点，且改域名会牵动 Cookie/CSRF，属部署级动作）→ 列入后端需求 |
| **13.15 站点文案可改**（`site_texts` 键值：默认简介 / AI 配置 / 邮件开关等） | DB §4.9 `site_settings`（`key/value/updated_at`）；§21.2 `GET/PATCH /admin/site-settings`（`site.setting`） | **做**：`screens/settings.tsx` —— 分组键值编辑（站点名 / 简介 / 注册与审核策略 / 打赏默认文案），改完有「未保存 / 已保存」态；公告与横幅（`announcements`/`banners`）同屏只读列出 |

小计：**做 13 条**（13.1–13.10、13.12、13.13、13.15）、**部分做 1 条**（13.14 只读）、
**不做 1 条**（13.11 数据备份），理由均已写在上表。

> **口径提醒（2026-10-14）**：13.10 经过一次翻转 —— 首版拍板「不做外部 AI」，之后产品改主意、d7 把它做成了。
> **这张表是「当时的设计决定」的快照，不是当前实现清单**；判断某一屏做没做，看 `nav.ts` + `index.tsx` + `registry.ts`，别只看本表。

## 2. 与第 14 章「权限 / 等级体系」的对应

| 老功能 | 新方案 | 本页落点 |
|---|---|---|
| 14.1 四级角色 + 16 个权限位矩阵 | RBAC：`roles`（层级树）+ `permissions`（代码常量）+ `role_permissions` | `screens/roles.tsx`：左侧角色树、右侧按 `grp` 分组的权限点勾选；权限点的**唯一真源是代码常量**（9.8），后台不许新增权限点 |
| 14.2 未激活用户可读不可写 | DB §4.1 `activated_at`（能登录、写操作 403 `auth.not_activated`） | `screens/users.tsx`：状态列把三根轴分开显示（`status` / `email_verified_at` / `activated_at`），不合成一个「状态」 |
| 14.3 分区级最低角色（`post_min_role`/`reply_min_role`） | D6：**被「允许哪几个角色」替代**（不引入角色优先级比较） | `screens/boards.tsx`：ACL 矩阵的角色行 = 旧「最低角色」的表达；矩阵为空 + `acl_enabled=false` 才是「登录即可发帖」 |
| 14.4 组 × 分区：`can_post/can_reply` + `deny_post/deny_reply`（禁止优先），可整体关闭 | D6 判定顺序 1–6；`board_acls` + `boards.acl_enabled` | `screens/boards.tsx`：**禁止优先的视觉表达** —— 命中 deny 的角色行标红并注明「第 4 步先拒绝」，判定顺序图按当前选择高亮 |
| 14.5 分区版主表 | `board_moderators`（带期限）；9.8「作用域权限不能放在中间件里」 | `screens/boards.tsx` 的版主任免区：只对 `board_moderators` 命中的分区可操作，其余分区给出「无该分区版主授权」的理由提示 |

## 3. 不在本页的东西（避免重复造）

- **权限点常量**：只在后端代码里（`internal/authz/permissions.go`），本页的权限下拉是**只读**展示。
- **点对点追加权限（`user_permissions`）**：本页只在用户详情里**只读展示**（含 `expires_at` 与 `reason`）；授予/回收是超管动作，需要端点（见回报）。
- **前端权限判定**：`useCan` 只是显示层；本页每屏都有一个「权限不足 → 不渲染」的示例，并注明后端才是判定层。

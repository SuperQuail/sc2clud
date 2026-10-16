# 权限系统设计（RBAC 基线 + 点对点追加）

> 2026-10-12 重做。**本文是权限的唯一真源**，数据库设计 §4.1 与后端方案的授权部分都指向这里。
> 本次重做的唯一目标：**降权必须能做到，并且在结构上不可能做不到。**
>
> **角色定位（2026-10-16 置顶声明，按拍板逐字）**：管理员是网站辅助管理者（站务、审核、内容与用户管理的落实者，不做部署与代码维护）；超级管理员是网站开发 / 维护 / 所有者（全权，含权限体系本身的变更）。

## 0. 为什么前两版都是错的

| 版本 | 问题 |
|---|---|
| 第一版：`user_roles` 多角色 + 权限取并集 | **加角色只增不减**。想把管理员降成普通用户，只能去「删角色」——漏删一次，降权就静默失败。降权靠人记得，不靠结构 |
| 第二版：`users.role_id` 单角色 | 降权必然可行，但**兼任做不了**：临时给几条权限只能整包给角色，给完又忘了收 |

共同错误：把「**权限基线**」和「**临时追加**」混在一个机制里（都用角色表达）。只要追加走整包角色，并集就必然导致不可降权。

## 1. 模型：基线唯一，追加是点对点

    roles              角色树（parent_id）—— 四个内置角色是一条链
    permissions        权限点（域.动作）
    role_permissions   角色 → 权限点（已展开的并集）
    users.role_id      **权限基线：单一、必填**
    user_permissions   **点对点追加**：给某个人加某几个权限点，带期限与理由
    board_moderators   分区级授权（带期限）—— 与全局基线正交

**一句话**：用户的权限 = **一个基线角色** ∪ **若干条显式追加的权限点（未过期）**。
并集只发生在「基线 ∪ 点对点」这一层；**角色与角色之间永远不并集**（一个人只有一个角色）。
这就是「降权一定能做到」的结构保证。

### 1.1 权限计算

    权限(user) = role_permissions(users.role_id)
               ∪ { p ∈ user_permissions(user) : p.expires_at IS NULL OR p.expires_at > now() }

- **基线**决定绝大部分权限，改一次 `users.role_id` 就整体重算；
- **追加**只能是**具体的权限点**，不能是整包角色——不存在「给了一个角色，连带拿到一堆没想到的权限」；
- 追加**必须带 `reason` 与 `granted_by`**（审计）；**建议带 `expires_at`**，到期自动失效，不需要有人记得去收。

### 1.2 表结构（授权部分）

**roles**：`id`、`key varchar(32) UNIQUE`、`name varchar(32)`、`parent_id bigint NULL fk roles RESTRICT`、
`depth int NOT NULL DEFAULT 0`、`description varchar(200) DEFAULT ''`、`badge_color varchar(16) NULL`、`is_system bool DEFAULT false`。
索引 `idx_roles_parent (parent_id)`；约束 `CHECK (parent_id IS NULL OR parent_id <> id)`。

**permissions**：`id`、`key varchar(64) UNIQUE`、`grp varchar(32)`、`description varchar(200)`。

**role_permissions**：`role_id`、`permission_id`，主键 `(role_id, permission_id)`，两侧 CASCADE；索引 `idx_role_permissions_permission (permission_id)`。

**users.role_id**：`bigint NOT NULL fk roles RESTRICT`（基线，单一）；索引 `idx_users_role (role_id)`。`RESTRICT` 让「有用户在用的角色删不掉」。

**user_permissions**（点对点追加）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| user_id | bigint | fk users CASCADE | |
| permission_id | bigint | fk permissions CASCADE | |
| granted_by | bigint | NULL fk users SET NULL | 操作人（系统任务为 NULL） |
| granted_at | timestamptz | NOT NULL DEFAULT now() | |
| expires_at | timestamptz | NULL | NULL = 永久；**建议非空** |
| reason | varchar(200) | NOT NULL | 审计：为什么给 |

主键 `(user_id, permission_id)`；索引 `idx_user_permissions_user (user_id)`、`idx_user_permissions_expires (expires_at) WHERE expires_at IS NOT NULL`；
约束 `CHECK (expires_at IS NULL OR expires_at > granted_at)`。

**board_moderators**：`board_id`、`user_id`、`granted_by`、`granted_at`、`expires_at NULL`，主键 `(board_id, user_id)`。
它给的只是「这个分区里能删帖/置顶」，不是全局权限。

## 2. 降权：三条路，全部显式

| 降权方式 | 操作 | 效果 | 审计 |
|---|---|---|---|
| **改基线** | `UPDATE users SET role_id = <更低角色>` | 权限立刻整体重算，**单调下降**，不必逐条回收 | `user.role.change` |
| **回收追加** | `DELETE FROM user_permissions WHERE user_id=? AND permission_id=?` | 只掉那几个点 | `user.permission.revoke` |
| **等到期** | 什么都不做 | `expires_at` 到点自动失效（查询过滤 + 定时清理） | 靠 `granted_by`/`reason`/`expires_at` 追溯 |

**结构保证**：一个人只有一个基线角色，**不存在「高角色与新角色叠在一起」的状态**——降权永远只需改一处，没有「改了三处漏一处」的失败模式。

### 2.1 硬规则（服务层强制）

1. **禁止**在 `users.role_id` 之外再造「加角色」的语义——没有第二张角色表；
2. 授予 `superadmin` / `admin` 必须走专门接口并写审计，不能由普通管理员自助；
3. 封号（`users.status`）与降权是两条独立通道：封号一票否决全部权限，降权改基线；
4. 任何授权动作后**主动失效该用户的 60 秒权限缓存**，不等 TTL。

## 3. 四个内置角色（权限矩阵）

「✓ 继承」= 来自子角色，`role_permissions` 里已展开，不需要单独配。

| 权限点 | 普通用户 user | 认证创作者 creator | 管理员 admin | 超级管理员 superadmin |
|---|---|---|---|---|
| `topic.create` / `reply.create` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.edit.own` / `reply.edit.own` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.delete.own` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `donation.view` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.pin` / `topic.feature` | — | ✓ | ✓ 继承 | ✓ 继承 |
| `resource.publish`（发资源帖） | — | ✓ | ✓ 继承 | ✓ 继承 |
| `topic.move` / `topic.lock` | — | — | ✓ | ✓ 继承 |
| `topic.delete.any` / `reply.delete.any` | — | — | ✓ | ✓ 继承 |
| `user.warn` / `user.mute` | — | — | ✓ | ✓ 继承 |
| `donation.review` | — | — | ✓ | ✓ 继承 |
| `board.moderate`（在 `board_moderators` 命中的分区内） | — | — | ✓ | ✓ 继承 |
| `user.ban` / `user.role.change` | — | — | — | ✓ |
| `board.manage` / `title.grant` | — | — | — | ✓ |
| `system.settings` / `audit.read` | — | — | — | ✓ |

`user` 是注册即得的基线；`creator` 需要认证动作；`admin` / `superadmin` 只能由 `user.role.change` 授予。

## 4. 判定与缓存

    authz.Permissions(user) → 基线 ∪ 未过期追加（缓存 60 秒）
    authz.Can(user, perm)   → 先查 users.status（封号一票否决），再查权限集合
    authz.CanInBoard(user, board, perm) → 全局权限 或 board_moderators 命中

- 缓存条目必须同时带 `role_id` 与 `users.status`；
- **禁止在 handler 里比较 `role.key` 字符串**，一律走 `authz.Can`；
- 权限点由代码常量定义、迁移写入；启动自检：代码集合 == `permissions.key` 集合。

## 5. 前端表现

| 元素 | 规则 |
|---|---|
| 角色徽标 | 显示**基线角色** `roles.name`；`badge_color` 有则上色，无则中性 |
| 权限下拉 | 默认不显示；**有追加权限或分区授权**时出现箭头，展开列出：基线角色、追加的权限点（含到期时间）、分区授权（哪个分区、何时到期） |
| 用户自己看 | 个人设置里的「我的权限」，同一份数据 |
| 前端判断 | `GET /api/me` 返回 `role`（基线）、`extra`（追加，含到期）、`permissions`（算好的集合）；前端只决定**显示与否**，**拦截永远在后端** |

## 6. 自检（迁移后与 CI）

1. `users.role_id` 无 NULL；
2. 每个非根角色的权限集合 ⊇ 父角色（写穿没漏）；
3. `depth` 与 `parent_id` 一致，无环无孤儿；
4. `user_permissions` 每行都有 `reason`（系统任务除外）；
5. 过期的追加行由定时任务清理并记审计；
6. `permissions.key` 集合 == 代码常量集合。

## 7. 迁移（旧站）

| 旧站 | 新库 |
|---|---|
| 4 级角色列 | 映射成四个内置角色之一 → `users.role_id`（一人一值） |
| 吧务 / 分区管理 | `board_moderators`（期限字段留空） |
| 头衔 | `titles` / `user_titles` / `users.equipped_title_id`（称号，与权限无关） |

旧站没有「点对点权限」，`user_permissions` 迁移后为空表——这是对的，不要为了对称造数据。

## 8. 变更流程

**加权限点**：`permissions.go` 加常量 → 迁移插 `permissions` 行 + 按 §1.1 写穿给需要的角色 → 自检 6；
**加角色**：迁移插 `roles` 行（指定 `parent_id`）→ 复制父角色权限集合 → 自检 2；
**临时给某人权限**：`INSERT INTO user_permissions` 带 `reason` + `expires_at` → 主动失效缓存；**不要**为了这个去动 `role_id`。

---

## 9. 源码实测（2026-10-16 只读审查续写）

> 本节由 2026-10-16 的只读审查写入：权限点、数量、判定次序**全部来自源码**（文件:行号清单见 §9.6）；凡是标「（作者注）」的定性话是文档作者的话，不是源码原文。§0–§8 是 2026-10-12 的设计稿，与当前源码已有出入——**以本节为准**，出入逐条列在 §9.5；本节只续写，不回改旧文。

### 9.1 角色定位（开门声明的源码侧证）

- **管理员**是网站辅助管理者——站务、审核、内容与用户管理的落实者，**不做部署与代码维护**。源码侧证：内置角色 seed 的描述「内容与用户管理」（0017_seed_authz.up.sql:16）；admin 持有的 17 个点全部是内容治理 / 用户治理动作（见 §9.2 表），没有部署、发版、权限体系类权限（role.edit 等留给 superadmin，role_permissions_test.go:22-23）。
- **超级管理员**是网站开发 / 维护 / 所有者——全权，**含权限体系本身的变更**。源码侧证：is_super 全库唯一（0002_accounts.up.sql:40 的 uq_roles_super；0017_seed_authz.up.sql:17-20）、角色描述「不可被降权，只能由 CLI 授予」（0017:17）、建超管只有 CLI 入口（auth/account.go:945-946 CreateAdmin；app/admin.go:52 打 role=superadmin）、加权限点只能改代码加迁移、后台禁止新增权限点（authz/authz.go:11-13；0017:7-8）。

### 9.2 角色 × 权限点（源码为准）

权限点全集 24 个：代码常量 authz/authz.go:13-58（All 数组的顺序＝迁移插入顺序）＝ seed 0017:26-51（key / grp / name / description 逐字）。四个内置角色 seed 时 parent_id 全 NULL、各自独立不成链（0017:10-13）。**生效矩阵**＝ 0017:60-101 加 0052 给 admin 补的 resource.publish（0052:34-40），与逐点对照测试 app/role_permissions_test.go:53-61 严格相等。数量：user 3 / creator 7 / admin 16（0017 实写）+ 1（0052）＝ **17** / superadmin 24。**表中权限点 key、中文释义、grp 三列直接取自 0017:26-51 与 authz.go:13-45；勾叉取自 0017:60-101 加 0052 矩阵；脚注里的定性句（标「作者注」处）才是文档作者的话。**

| key | permissions.name（中文释义） | grp | user | creator | admin | superadmin |
|---|---|---|---|---|---|---|
| topic.create | 发主题与回复（四合一①） | topic | ✓ | ✓ | ✓ | ✓ |
| topic.edit.own | 编辑自己的内容 | topic | ✓ | ✓ | ✓ | ✓ |
| topic.delete.own | 删除自己的内容 | topic | ✓ | ✓ | ✓ | ✓ |
| topic.delete.any | 删除任何人的内容 | topic | — | — | ✓ | ✓ |
| topic.lock | 锁定主题 | topic | — | ✓ | ✓ | ✓ |
| topic.pin | 置顶与精华（两端点共用②） | topic | — | ✓ | ✓ | ✓ |
| topic.move | 移动主题 | topic | — | ✓ | ✓ | ✓ |
| resource.publish | 发资源帖（发 kind=resource 时额外要它③） | topic | — | ✓ | ✓（0052 补） | ✓ |
| board.manage | 分区管理（分区增删改、排序、封面、ACL 矩阵） | board | — | — | ✓ | ✓ |
| board.moderate | 分区版主（作用域权限④） | board | — | — | ✓ | ✓ |
| post.review | 帖子审核（队列放行/拒绝/请求修改；申诉判定同点） | topic | — | — | ✓ | ✓ |
| report.handle | 处理举报（举报队列；申诉队列同点） | user | — | — | ✓ | ✓ |
| reward.verify | 赞赏核验（人工核验打赏申报） | user | — | — | ✓ | ✓ |
| title.grant | 授予头衔（给用户发 / 收头衔） | title | — | — | ✓ | ✓ |
| title.manage | 头衔目录维护（新建 / 归档头衔） | title | — | — | ✓ | ✓ |
| user.ban | 封号与解封（封号/解封/禁言⑤；用户组 CRUD 也挂它⑥） | user | — | — | ✓ | ✓ |
| user.mute | 分区限期禁言（Sanction 表）⑤ | user | — | — | ✓（点未接线） | ✓ |
| role.edit | 编辑角色权限（改角色 × 权限矩阵） | user | — | — | — | ✓ |
| role.assign | 分配角色（改 users.role_id） | user | — | — | — | ✓ |
| permission.grant | 点对点授权（追加 / 回收 user_permissions） | user | — | — | — | ✓ |
| mail.manage | 发信账号维护（后台邮件账号） | site | — | — | — | ✓ |
| site.setting | 站点设置（键值、公告、横幅、自检面板） | site | — | — | — | ✓ |
| audit.view | 查看审计日志 | site | — | — | — | ✓ |
| audit.export | 导出审计日志（单列：能一次导走全站操作痕迹） | site | — | — | — | ✓ |

① authz.go:15：一个点管发主题、发回复、发 issue 与 issue 评论；端点侧 issues.go:220/398、posts.go:103、topics.go:292 都走 topic.create。② authz.go:20（拍板 §10.9 定案，不设 topic.feature）；锁定与关 Issue 共用 topic.lock（service.go:113-146）。③ authz.go:22 的注释如此宣称，但当前代码里没有任何判定使用点（§9.5-4）。④ authz.go:25：只在 board_moderators 命中的分区内生效，判定见 §9.3 第 3 层。⑤ 已授予 admin，但 sanctions 表没有任何生产写路径（§9.5-4）。⑥ 用户组路由的闸门是 user.ban（§9.5-6）。

**角色之外的三个对照（两三行带过）**：

- **user（普通用户）**：基线 3 点（0017:60-68），注册即得；他在各分区能不能发 / 能不能回，主要由分区 ACL 与两档等级门槛决定（§9.3 第 4 层）。
- **banned（封号）**：users.status 在会话解析层一票否决（session.go:34-38，status 非 active 一律当游客并清 Cookie）；读接口对游客开放，写接口 401（middleware.go:41-50）。封号不动 role_id，与降权是两条独立通道（判定的落点在解析层，不在权限集合里）。
- **版主不是角色**：版主＝任意基线角色 + board_moderators 在任行（grown_at IS NULL 且未过期，0003:104-120 加 0051:20-25），而版主能力真正生效还必须同时持有 board.moderate 权限点（§9.3 第 3 层是 AND 关系）。admin 基线自带该点（0017:88）；**任命 user / creator 为版主通常不产生任何版主能力**，要配合 permission.grant 点对点补授 board.moderate（§9.5-5）。

### 9.3 叠加规则与判定次序（按实际代码的顺序，非直觉）

**第 0 层·权限装配（每请求实时查库，无缓存）**：Resolve 解析会话并查 users.status（session.go:23-40，封号在此就降为游客）→ LoadActorSQL＝**基线角色链上的勾选（WITH RECURSIVE 沿 parent_id 上溯）∪ 未过期的点对点追加（user_permissions）**（查询注释「权限闭包」queries.go:162；SQL 在 ：165-195；内置四角色 parent_id 为 NULL 时链退化为单角色，这条递归是为自定义角色留的）→ 同时取 BoardIDs＝在任版主任期（queries.go:186-189；「三条 SQL 必带 grown_at IS NULL」的纪律清单在 0051:13-18）。Principal.Actor() 把它投影成 authz.Actor（principal.go:46-63）。**注意：没有任何缓存**——InvalidateSession / InvalidateUser 是 no-op（session.go:217-222），授权动作无需失效、下一个请求即生效。

**第 1 层·中间件（先认证后权限）**：RequireLogin（status 非 active → 401，middleware.go:41-50）→ 写路由必须挂 RequireActivated（唯一的写闸门，:52-67；EmailVerified 不挡任何功能）→ Perm / PermAny 的次序是 **status → IsSuper 短路 → HasAll / HasAny**（middleware.go:83-108，短路在 ：94-97）。作用域权限与资源归属判定**不进中间件**（middleware.go:69-71；authz.go:6）。

**第 2 层·service 的全局点判定**：requirePerm 把 IsSuper 短路放在权限集合之前（forum/service.go:76-82；authz.go:5 硬规则 2）。路由层与 service 层各判一次同一权限点（路由层见 §9.6 的 handler 行号）。

**第 3 层·作用域权限 board.moderate**：最终判据是 **Perms.Has(board.moderate) 且 CanInBoard(boardID) 两者同时成立**（canEditTopic 的第三条判据 forum/service.go:110；canLockAs 第三条 ：145）。CanInBoard 先 IsSuper 短路，再线性命中 BoardIDs（authz.go:120-134）——它只回答「是不是这个分区的版主」，点本身必须已在权限集合里。

**第 4 层·分区发言 ACL（canSpeak，六步；只覆盖五条「新增内容」路径：发主题、发回复、发 issue、发 issue 评论、传配图；编辑/删除/锁定/置顶/收藏/投票不判发言权，acl.go:12-27）**：
1. 超管放行，这条 SQL 都不查（acl.go:29-31）；
2. 未过期禁言优先于 ACL（acl.go:17、40-48）；
3. acl_enabled=false 分支：can 与矩阵一起失效，但**显式 deny（角色行 ∪ 组行）仍然终局**（D62 修正，acl.go:54-63）；
4. acl_enabled=true：角色行或任一组行 deny → 拒绝（D38 语义②：任一层 deny 终局，另一层 can 多少都救不回来，acl.go:64-68）；
5. 角色行 can 或任一组行 can → 走对应档的等级门槛（发帖看 min_post_level，回复看 min_reply_level，acl.go:49-53 加 0027:15-18；D38 语义①：组授是加法授权，acl.go:69-73）；没有 can 命中则进入白名单拒绝；
6. 板上配了组规则但组里没这个人 → 文案点出「用户组」（acl.go:74-83），同样拒绝（白名单制）。最后 checkMinLevel 读 users.level（acl.go:86-110）。

一句话（作者注）：能发的集合＝基线角色行 can ∪ 组行 can；禁发的来源＝角色行 deny ∪ 组行 deny ∪ 禁言，**禁止优先、deny 终局、且不受 acl_enabled 开关影响**。

**ACL 的数据形状**：board_acls 按「基线角色」一行 LEFT JOIN（access.go:93——矩阵行键是角色，没有按用户的行）；board_group_acls 对用户所属全部组用 bool_or 合并（access.go:104-112）。ACLRowFor 的注释明说「没有第五支」：topic.create 之类的权限点已在 Actor.Perms 判过，再查 role_permissions 就是第二份真源（access.go:9-12）。所以**组/ACL 层不叠加、也不收窄发言之外的能力**：它只决定发与回。编辑/删除走 canEditTopic（作者 own → any → 版主作用域，先 Require 再判归属，service.go:98-111），锁定与关 Issue 共用 canLockAs 四条判据（service.go:113-146）。

**写矩阵与版主任免的闸门**：分区 ACL 矩阵与组矩阵的读写都＝board.manage（admin_boards_acl.go:20/39；groups_admin.go:403/419；路由 handler.go:147-148）；写入是全量替换（先清后插，admin_boards_write.go:61-80；组行同款 user_groups.go:202-229）；矩阵里**拒绝写超管角色的行**（D40：矩阵在结构上管不到超管，admin_boards_acl.go:77-80 加 admin_boards_write.go:93-103）；is_super 的判定在 ACL 链路第 1 步就短路，矩阵写没写都一样（acl.go:29-31）。分区版主任免也挂 board.manage（admin_boards_write.go:57-59/135），任命是幂等 upsert「重复任命＝改任期」、免职置 grown_at 不删行（:144-164）。同一行 can 与 deny 互斥由 ck_board_acls_no_contradiction 类 CHECK 保证（0004:39 起；同款 0055:58-59）；违反时 service 先 400 而不是让 DB 报错误导（admin_boards_acl.go:51-56）。

### 9.4 哪些事只有超级管理员能做（以真实权限点为准）

基线 admin（17 点）与 superadmin（24 点）的差集是 **7 个权限点**（0052:4-5 与 role_permissions_test.go:22-23 都明文「提权类权限只归 superadmin」；作者注：这正是「管理员是辅助管理者」在权限上的直接体现）：

| 权限点 | 实际能做的事（端点为证） |
|---|---|
| role.edit | 读角色与权限点目录、改角色 × 权限矩阵（auth/handler.go:68-70）。改矩阵会立即重算该角色所有人的权利（或收窄）——权限体系日常变更的唯一后台入口 |
| role.assign | 改用户的基线角色 users.role_id（auth/handler.go:71；privileges.go:188-233）。目标超管且剩余活跃超管数为零时拒绝（guardLastSuper，account.go:896-921） |
| permission.grant | 点对点追加/回收某人的权限点，reason 必填（auth/handler.go:72-73；privileges.go:244-256；可带 expires_at） |
| mail.manage | 发信账号增删改查与发测试信（mail/handler.go:33-37） |
| site.setting | 站点设置 / 域名 / 公告 / 横幅（site/handler.go:42-50）、自检诊断面板（auth/handler.go:78 加 admin_diagnostics.go:71）、邮件模板（mail/handler.go:40）、赞赏公告默认（reward/handler.go:54-55）、发布版本与资产（release/handler.go:36-40；该行注释自述 21.2 没有更细权限点——作者注） |
| audit.view | 审计日志查看（auth/handler.go:79；auth/audit.go:147）。admin 没有 audit.* 任何点——审计读超管专属 |
| audit.export | 审计日志导出（auth/handler.go:80；auth/audit.go:182） |

resource.publish 不是 superadmin 专属（admin 经 0052 持有），尽管这个点判定还没接线（§9.5-4）。

非权限点、但同样只有 superadmin 身份才成立的：

- is_super 角色全库唯一，第二个都建不出来（0002:40）；「授予 superadmin 角色」只有迁移 seed 与 CLI CreateAdmin 两条路（0017:14-17；account.go:945-954），普通管理员的 API 改 base role 也要过 guardLastSuper。
- 超管的短路覆盖所有层：中间件（middleware.go:94-97）、service 的 requirePerm（forum/service.go:78 等）、恰好发言 ACL 连 SQL 都不查（acl.go:29-31）、CanInBoard（authz.go:125-127）——以及 D40 保证 ACL 矩阵永远写不进超管行。
- 把基线是 user 的用户临时升格点权（permission.grant）会写 user_permissions 并带审计（privileges.go:244 起；0003:56-76 表）——Authorization 的加法通道，作者注。

### 9.5 审查发现（与「文档化」目标不符 / 建议 Lead 拍板）

1. **启动自检的 admin 期望数停在 16**：schema_check.go:126-128 的 rolePermCounts 是 3/7/16/24，但 0052 起库里 admin＝17（role_permissions_test.go:53-61 逐点等 17 个）。每台正常迁移过的实例每次启动都会打「权限数与 seed 不一致」的 Warn（CheckRoleSeeds，schema_check.go:157-159），这条自检成了常鸣噪音；照它读会得出「admin＝16」的错误事实。一行修复：rolePermCounts admin→17。
2. **0017 自己的注释数字自相矛盾**：0017:57/70/81 写「creator 8 / admin 17」，同一文件 INSERT 实写 7/16（正是 0052:9-16 描述的那场事故）。0052 修了数据，0017 的注释原样保留——只读注释会得出错误矩阵。作者注：改注释即可，不影响行为。
3. **旧稿 §3 矩阵（第 83-104 行）全面过时**：reply.create / donation.view / topic.feature / user.warn / donation.review / user.role.change / system.settings / audit.read 这些 key 在现今 24 点全集里不存在（0017:26-51）；「四个内置角色是一条链」与 0017:10（parent_id 全 NULL 各自独立）矛盾——但 LoadActorSQL 的递归链仍在（queries.go:166-171），服务的是自定义角色；「✓ 继承」的说法应换成「矩阵已在 role_permissions 里展开」。creator 实际有 topic.lock / topic.move / topic.pin（0017:76；role_permissions_test.go:21-22 的理由是「创作者管自己的帖子」）。§2.1-4 与 §4 的「60 秒权限缓存 / 主动失效」同样与代码不符（见发现 8）。
4. **两个已授予但完全没接线的权限点**：user.mute 与 resource.publish 在全部 service 判定（requirePerm / Perms.Has 清单，authz.go 之外的调用点见 §9.6）中零引用。禁言的读侧在（ACLRowFor 的 sanction 支 access.go:94-103 加 canSpeak 第 2 步 acl.go:40-48）与 notify:sanction 任务也在（platform/queue/types.go:16），但没有任何生产代码插入 sanctions（全库只有测试 INSERT：auth/admin_users_test.go:264、271 等）；发 kind=resource 的 kind 校验只有枚举合法性（topics.go:690）。而 0052:9-11 修库的初衷（「管理员发资源帖被 403」）恰恰说明预期存在这条判定门槛——**判定本身没落码，待 Lead 拍板补上或写明不做**。
5. **版主任命的语义断层**：canEditTopic / canLockAs 的版主分支是 Perms.Has(board.moderate) 且 CanInBoard（service.go:110/145）。user / creator 基线没有这个点（0017:70-79），任命他们为版主后 CanInBoard 为真却拿不到任何作用域能力，必须再走 permission.grant 补 board.moderate；admin 自带（0017:88）。**待核实**：任命流程是否应当自动授予该点（或在界面上提示）。另外 ACLRowFor 查出的 IsModerator（access.go:37/90-92）在 canSpeak 里从未使用——不存在「版主在本区发言豁免」这条规则，版主发言与普通人同受 ACL 与禁言约束。
6. **用户组管理挂在 user.ban 下**：handler.go:140-146 加 groups_admin.go:76-81——建组 / 删组 / 加减组员的闸门与封号同门；分区 × 组矩阵却挂 board.manage（groups_admin.go:403/419）。作者注：组是白名单细粒度管理（D38），与「封号与解封」（0017:45 的 name 逐字）语义混搭，是否有意（复用 admin 已有点）还是需要独立点，待 Lead 拍板。
7. **判定全程不比角色 key**：role_key 只用于展示与审计（authz.go:111 的硬规则在 canEditTopic / canLockAs / canSpeak / 路由闸全链路都成立，没有字符串比较权限的分支）；启动自检只数 role_permissions 数量且只 Warn 不断言集合（schema_check.go:126-159）——集合级强断言在 app/role_permissions_test.go:99-124。这一部分与设计稿一致，无需改。
8. **权限缓存不存在**：旧稿 §4「缓存 60 秒」/ §2.1-4「主动失效缓存」当前无实现——InvalidateSession / InvalidateUser 是 no-op（session.go:217-222），注释自述「每次都查库（没有第二份真源、没有缓存条目）」。待核实：取消缓存是拍板还是实现偏离；旧稿两处若已拍板，本节 §9.3 第 0 层即为准。
9. **moderator 角色已被 0023 并入 creator**（0023:1-11）：「版主」的概念完全由 board_moderators 表达（这一点与 §9.2 一致，是旧文档 §7 的迁移映射行「吧务 → board_moderators」的正确化）。另外 0023:5 注释说「后台可以建 key=moderator 的角色」，但当前路由只有 GET /roles 与 PATCH 角色矩阵、没有角色新建端点（auth/handler.go:68-71）——**待核实**自定义角色创建是否已撤离范围。

### 9.6 事实来源（文件:行号清单）

- 权限点常量与 Actor：forum/internal/authz/authz.go:3-6（三条硬规则）、:13-58（常量与 All）、:103-118（Actor）、:120-134（CanInBoard）
- DDL：forum/migrations/postgres/0002_accounts.up.sql:22-40（roles，含 is_super 与 uq_roles_super :40）、:45-52（permissions，含 grp）、:57-66（role_permissions）；0003_authz.up.sql:56-76（user_permissions）、:104-120（board_moderators）；0004_forum.up.sql:25-27（boards 的 acl_enabled / min_post_level 默认）、:39-（board_acls 建表）；0027_board_reply_level.up.sql:15-18（min_reply_level 落列与判定说明）；0051_board_moderator_grown.up.sql:13-25（grown_at + 三条 SQL 的纪律）；0055_user_groups.up.sql:4-8（D38 两句语义）、:12-28（user_groups）、:33-42（user_group_members）、:45-60（board_group_acls）；0023_moderator_to_creator.up.sql:1-11
- 种子与矩阵：0017_seed_authz.up.sql:10-20（四角色）、:26-53（24 权限点）、:60-101（矩阵）；0052_admin_resource_publish.up.sql:1-20（修 0017 漏点的理由）、:34-40（补点）；forum/internal/app/role_permissions_test.go:12-61（矩阵权威对照）
- 启动自检：forum/internal/auth/schema_check.go:126-159（rolePermCounts 与 CheckRoleSeeds）
- 会话与权限装配：forum/internal/auth/session.go:21-40（Resolve 与封号）、:42-77（loadPrincipal）、:217-222（Invalidate no-op）；forum/internal/auth/pgsql/queries.go:100-118（ResolveSessionSQL，board_ids LATERAL 在 :110-116）、:161-195（LoadActorSQL：递归角色链 ∪ 点对点追加 ∪ BoardIDs ∪ extra）、:220-240（LoadActor）；forum/internal/auth/principal.go:46-63（Actor 投影）
- 中间件：forum/internal/auth/middleware.go:14-38（LoadPrincipal）、:41-50（RequireLogin）、:52-67（RequireActivated）、:69-108（Perm / PermAny 与 IsSuper 短路）
- service 层判定：forum/internal/forum/service.go:68-82（requireActor/requirePerm）、:93-96（canReview）、:98-146（canEditTopic / canCloseIssue / canLockAs）、:148-164（ShowDislike 用 topic.delete.any 代「管理员」）；forum/internal/forum/acl.go:12-110（canSpeak 六步与 checkMinLevel）、:112-127（checkBlocks）；forum/internal/forum/pgsql/access.go:9-12（无第五支）、:13-67（ACLRow 与组合并）、:69-130（ACLRowFor 一条查询四张表）
- 矩阵与版主管理：forum/internal/forum/admin_boards_acl.go:14（注释 权限点一律 board.manage）、:20/39（闸门）、:51-56（can/deny 互斥的先行 400）、:77-80（D40 拒超管行）；forum/internal/forum/admin_boards_write.go:61-80（全量替换）、:93-103（SuperRolesAmong）、:144-164（版主 upsert / 置 grown_at）；forum/internal/forum/groups_admin.go:76-81（组闸 user.ban）、:401-470（组矩阵闸 board.manage）；forum/internal/forum/handler.go:140-148
- 提权与守卫：forum/internal/auth/privileges.go:188-233（SetUserRole 与 guardLastSuper 调用）、:244-275（GrantPermission）；forum/internal/auth/account.go:896-921（guardLastSuper 实现）、:945-954（CLI CreateAdmin）；forum/internal/app/admin.go:52
- 各权限点的路由闸门（代表性）：forum/internal/auth/handler.go:64-80（user.ban / role.edit / role.assign / permission.grant / site.setting / audit.*）；report/handler.go:39-41（report.handle）；reward/handler.go:50-55（reward.verify 加 site.setting 两条）；title/handler.go:41-46（title.grant / title.manage）；mail/handler.go:33-40（mail.manage 与 mail 模板的 site.setting）；site/handler.go:42-50（site.setting）；release/handler.go:36-40（site.setting）；forum/handler.go:89-91（topic.lock / topic.pin 两个端点）与 forum/internal/forum/topics.go:690（kind 枚举校验）；appeal/service.go:31-32（permQueue=report.handle、permDecide=post.review）
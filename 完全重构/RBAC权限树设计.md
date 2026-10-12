# 权限系统设计（RBAC 基线 + 点对点追加）

> 2026-10-12 重做。**本文是权限的唯一真源**，数据库设计 §4.1 与后端方案的授权部分都指向这里。
> 本次重做的唯一目标：**降权必须能做到，并且在结构上不可能做不到。**

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
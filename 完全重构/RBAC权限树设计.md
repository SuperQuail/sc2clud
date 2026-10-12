# RBAC 权限树设计

> 2026-10-12。**本文是权限的唯一真源**，数据库设计 §4.1 与后端方案的相关表格都指向这里。
> 起因：原设计把「一个用户可多角色」写进了文档（抄 RBAC 的 N:N 惯性），但本产品的权限是**一棵树**——
> 超级管理员 / 管理员 / 认证创作者 / 普通用户，一个人站在一个节点上。现在按 RBAC 重新设计。

## 1. 模型（四张表，一个外键）

    roles            角色树（parent_id 指向父角色）
    permissions      权限点（原子操作，如 topic.delete.any）
    role_permissions 角色 → 权限点（**已展开的并集**，不含递归）
    user_roles       用户 → 角色（**可多**；正常情况只有一个，多角色是例外）

关键决策：

1. **角色是一棵树**（`roles.parent_id`），四个内置角色是一条链：
   `superadmin → admin → creator → user`。父角色**拥有子角色的全部权限**。
2. **`role_permissions` 存展开后的并集**，不存差分。理由：判定路径只有一次 join，不做递归 CTE；
   代价是改基础角色的权限要**写穿到所有祖先**——这在服务层一个事务里完成（见 §5）。
3. **用户可以持有多个角色，但展示与判定都有确定规则**（见 §1.1）：
   - **授权** = 所有角色权限的**并集**（标准 RBAC）；
   - **展示** = **最高权限的那个角色**，其余的收进下拉列表。
4. **权限点由代码定义、由迁移写入**：`internal/authz/permissions.go` 的常量 ↔ `permissions.key` 一一对应；
   启动时校对：代码有表里没有 → 启动失败；表里有代码没有 → Warn。

### 1.1 多角色时的算法（2026-10-12 定）

数据上允许一个人有多个角色，但**对外永远只呈现一个最高角色**，其余收进下拉。

**A. 授权（判权限）—— 取并集**

    权限集合(user) = ⋃ role_permissions WHERE role_id IN (user 的全部角色)

并集是 RBAC 的标准语义：兼任两个角色时，两边给的权限都算数。**不做「取最高角色后只用它的权限」**——
那会让兼任变成降权（例如 creator + admin 只按 admin 算，如果 creator 有一条 admin 没有的权限就会丢掉）。

**B. 展示（给人看）—— 取最高**

    ORDER BY roles.depth ASC, roles.priority DESC, roles.id ASC  LIMIT 1

- `depth` 越小越靠近根（超级管理员 depth=0）→ 权限越高；
- 同级（理论上不该出现）按 `priority DESC` 再按 `id ASC`，**保证结果稳定**，不会因为查询顺序变来变去；
- 前端默认只显示这一个徽标；**该用户角色数 > 1 时**，徽标旁出现下拉箭头，展开列出全部角色（名字 + 层级），需要时可见但平时不喧哗。

**C. 边界**

| 情况 | 处理 |
|---|---|
| 一个角色都没有 | 不允许（注册即授予 `user`）；查询兜底返回空集合，判定一律拒绝 |
| 角色被删除 | `user_roles` 级联删除该行；有用户在用 `is_system` 角色时由 service 挡住 |
| 同一用户同一角色重复授予 | 主键 `(user_id, role_id)` 天然去重 |
| 缓存 | 权限集合与「最高角色」一起缓存 60 秒；授予/回收角色、改角色权限、封号时主动失效 |

**D. 代码落点**

    authz.Roles(user)      → 全部角色（按 B 的排序，第一个就是最高）
    authz.Permissions(user) → 并集（缓存）
    authz.Can(user, perm)   → 判并集，且同时校验 users.status

前端拿到的 `GET /api/me`：`role`（最高，用于展示）+ `roles`（全部，用于下拉）+ `permissions`（并集，仅用于显示与否）。

## 2. 表结构

**roles**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity PK | |
| key | varchar(32) | UNIQUE NOT NULL | `superadmin` / `admin` / `creator` / `user`，**迁移后不可改** |
| name | varchar(32) | NOT NULL | 显示名：超级管理员 / 管理员 / 认证创作者 / 普通用户 |
| parent_id | bigint | NULL fk roles(id) ON DELETE RESTRICT | 父角色；根为 NULL |
| depth | int | NOT NULL DEFAULT 0 | 层级（0=根），由 service 维护，便于排序与「至少管理员」这类判断 |
| description | varchar(200) | NOT NULL DEFAULT '' | |
| badge_color | varchar(16) | NULL | 徽标颜色（可选，运营配）；不配则中性徽标 |
| is_system | bool | NOT NULL DEFAULT false | 内置角色：禁止删除、禁止改 key |

约束：`CHECK (parent_id IS NULL OR parent_id <> id)`；`CHECK (depth >= 0)`。
索引：`idx_roles_parent (parent_id)`（FK 列必须有索引）。

**permissions**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity PK | |
| key | varchar(64) | UNIQUE NOT NULL | `域.动作`，如 `topic.delete.any` |
| grp | varchar(32) | NOT NULL | 分组：topic / reply / user / board / donation / system |
| description | varchar(200) | NOT NULL | 中文说明，后台直接显示 |

**role_permissions**：`role_id` + `permission_id`，主键 `(role_id, permission_id)`，两侧 CASCADE。
子表侧索引：`idx_role_permissions_permission (permission_id)`（复合主键的第二列不算已索引，这是原设计的已知坑）。

**users 表里没有角色列**：角色关系全部走 `user_roles`（见上）。删角色时由 service 检查是否还有人持有。

## 3. 四个内置角色的权限矩阵

「✓ 继承来的」= 来自子角色，不需要单独配；「✓」= 本级新增。

| 权限点 | 普通用户 user | 认证创作者 creator | 管理员 admin | 超级管理员 superadmin |
|---|---|---|---|---|
| `topic.create` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `reply.create` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.edit.own` / `reply.edit.own` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.delete.own` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `donation.view` | ✓ | ✓ 继承 | ✓ 继承 | ✓ 继承 |
| `topic.pin` / `topic.feature` | — | ✓ | ✓ 继承 | ✓ 继承 |
| `resource.publish`（发资源帖） | — | ✓ | ✓ 继承 | ✓ 继承 |
| `topic.move` / `topic.lock` | — | — | ✓ | ✓ 继承 |
| `topic.delete.any` / `reply.delete.any` | — | — | ✓ | ✓ 继承 |
| `user.warn` / `user.mute` | — | — | ✓ | ✓ 继承 |
| `board.moderate`（所辖分区） | — | — | ✓ | ✓ 继承 |
| `donation.review`（核验打赏） | — | — | ✓ | ✓ 继承 |
| `user.ban` / `user.role.grant` | — | — | — | ✓ |
| `board.manage` / `title.grant` | — | — | — | ✓ |
| `system.settings` / `audit.read` | — | — | — | ✓ |

**规则**：`user` 是所有人的基线（注册即得）；`creator` 是**认证创作者**——需要认证动作才授予；
`admin` 与 `superadmin` 由 `user.role.grant` 授予，只有 superadmin 有这一条。

## 4. 判定与缓存

    权限集合(user) = ⋃ role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)

- 缓存 60 秒（按 user_id），**缓存条目必须同时带全部 role_id 与 users.status**：封号/改角色要能立刻生效；
- 改角色权限、授予用户角色、封号时，主动失效对应用户的缓存（不等 TTL）；
- 分区级授权仍走 `board_acls`（`board_id` + `role_id` → can_post / can_reply / deny_*），与角色树正交；
- 服务层判定只调用 `authz.Can(user, perm)`，**禁止在 handler 里比较 `role.key` 字符串**（那等于把权限树写死在代码里）。

## 5. 改权限时的写穿（本文最重要的操作）

给一个角色加/删权限点 `P` 时，必须在**同一个事务**里写穿到它的所有祖先：

    -- 加：角色 R 及其所有祖先都授予 P
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT a.id, (SELECT id FROM permissions WHERE key = $1)
    FROM role_ancestors($2) a          -- 递归 CTE：自身 + 所有祖先
    ON CONFLICT DO NOTHING;

    -- 删：只有「没有任何后代还拥有它」时才从祖先移除（否则祖先会丢掉本该继承的权限）

自检（迁移后必跑）：

1. 每个非根角色 `R`：`permissions(R) ⊇ permissions(parent(R))` —— 违反说明写穿漏了；
2. `depth` 与 `parent_id` 一致（无环、无孤儿）；
3. 每个 `users.role_id` 都能在 `roles` 里找到（FK 保证）；
4. `permissions.key` 集合 == 代码常量集合。

## 6. 前端表现

| 元素 | 规则 |
|---|---|
| 角色徽标 | 只显示**最高角色**；`badge_color` 有则上色，没有就中性徽标。**颜色是数据，不是控件里的表** |
| 多角色下拉 | 角色数 > 1 时，徽标右侧出现下拉箭头，展开列出**全部角色**（名字 + 层级）；单角色时不显示箭头 |
| 用户名 | 不因角色变色（除非业务显式传 `color`）；未激活只是暗色 |
| 权限判断 | 前端只做**显示与否**，用后端下发的权限集合（`GET /api/me` 返回 `permissions: string[]`）；**真正的拦截在后端** |
| 分区版主 | 单独标记（`board_moderators`），不要塞进角色树——它是「在某个分区里」的授权，与全局层级正交 |

## 7. 与旧站的映射（迁移）

| 旧站 | 新库 |
|---|---|
| 4 级角色列 | 四个内置 `roles` 之一 → 一行 `user_roles`（迁移时每人恰好一行） |
| 吧务 / 分区管理关系 | `board_moderators`（保持不变，是分区级授权） |
| 头衔 | `titles` / `user_titles` / `users.equipped_title_id`（与权限无关，只是称号） |

## 8. 变更流程（加一个角色 / 加一个权限点）

**加权限点**：先在 `internal/authz/permissions.go` 加常量 → 写迁移（`permissions` 插一行 + 按 §5 授权给需要的角色）→ 启动自检通过；
**加角色**：写迁移（`roles` 插一行，指定 `parent_id`）→ 按 §5 把父角色的权限集合复制过去 → 自检 §5.1 通过。
**两者都不需要改前端控件**——控件只认 `name` 与可选的 `badge_color`。
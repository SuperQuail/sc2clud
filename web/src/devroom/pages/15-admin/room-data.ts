import type { AdminACLItem, AdminBoard, Diagnostics } from '@/lib/api/admin';
import { BOARDS, BOARD_MODERATORS } from './mock';

// DevRoom 15-admin **这两屏**的房间演示数据（boars / diagnostics）。
//
// 为什么单独一个文件：mock/ 里那份是**旧形状**（AdminBoard 有 sort 与 cover_file、版主挂在另一个数组、
// 自检项是布尔 ok），而屏已经照后端 DTO 改成 prop 驱动了。把旧 mock 硬塞进新屏只有两条路：
// 改 mock（会牵动 mock/content.ts 的其它使用者）或者在这里做一次**显式**的映射。
// 这里是后者 —— 而且它有个额外好处：这张映射表本身就是「旧设计的字段 vs 后端真字段」的对照。
//
// 字段名一律照 forum/internal/**（AdminBoardDTO / AdminACLItem / DiagnosticsDTO）。

/** mock 的角色 id 是字符串（r_user…），而后端的 role_id 是自增数字 —— 这张表就是那个换算。 */
const ROLE_ID: Record<string, number> = { r_user: 1, r_creator: 2, r_moderator: 3, r_admin: 4, r_superadmin: 5 };

/** 旧 mock 的 board_id（b_1）→ 后端的 uuid 形状（这里用可读的假 uuid） */
const BOARD_ID: Record<string, string> = Object.fromEntries(
  BOARDS.map((b, i) => [b.id, 'b0000000-0000-4000-8000-00000000000' + (i + 1)]),
);

export const ADMIN_BOARDS: AdminBoard[] = BOARDS.map((b, i) => ({
  id: BOARD_ID[b.id]!,
  slug: b.slug,
  name: b.name,
  description: b.description,
  cover_hash: '',
  status: b.status,
  acl_enabled: b.acl_enabled,
  min_post_level: 0,
  // position 是后端 row_number() 算出来的行号（1 起），不是 sort 值
  position: i + 1,
  topic_count: b.topic_count,
  post_count: b.post_count,
  today_count: b.today_count,
  // 列表项里的 moderators[] 只含**在任**的任期（历史行只有 GET .../moderators 给）
  moderators: BOARD_MODERATORS.filter((m) => m.board_id === b.id).map((m) => ({
    user_id: 'u0000000-0000-4000-8000-00000000000' + (i + 1),
    handle: m.user.handle,
    nickname: m.user.nickname,
    granted_at: m.granted_at,
    expires_at: m.expires_at,
  })),
}));

/** 每个分区一张矩阵。**缺行 = 这一分区没给那个角色任何权限**（后端也是这个语义）。 */
export const ADMIN_ACLS: Record<string, AdminACLItem[]> = Object.fromEntries(
  ADMIN_BOARDS.map((b) => [
    b.id,
    [
      { role_id: ROLE_ID['r_user']!, role_key: 'user', can_post: false, can_reply: true, deny_post: b.acl_enabled, deny_reply: false },
      { role_id: ROLE_ID['r_creator']!, role_key: 'creator', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
      { role_id: ROLE_ID['r_admin']!, role_key: 'admin', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
      { role_id: ROLE_ID['r_superadmin']!, role_key: 'superadmin', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
    ],
  ]),
);

/** 自检面板：三态（ok / fail / skipped），不是布尔。 */
export const DIAGNOSTICS_ROOM: Diagnostics = {
  debug_enabled: true,
  version: 'dev-1c4a9f2',
  started_at: '2026-10-12T02:00:00Z',
  readonly: true,
  total: 4,
  failed: 1,
  checks: [
    { name: '权限点集合一致性', status: 'ok', ok: true, detail: '代码常量 24 个 == permissions 表 24 行', ms: 12 },
    { name: '枚举值域与代码常量', status: 'ok', ok: true, detail: '全部枚举与 DDL 的 CHECK 一致', ms: 9 },
    { name: '数据库迁移版本', status: 'fail', ok: false, detail: '迁移处于 dirty 状态：修好 SQL 后先 forum migrate force 再重跑', ms: 3 },
    { name: '外键索引完备', status: 'skipped', ok: false, detail: '', ms: 0 },
  ],
};

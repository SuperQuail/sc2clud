import type { UserSummary } from '@/ui/user/user-badge';
import { USERS } from './users';
import type { AdminUser } from './core';

function u(username: string): AdminUser {
  const found = USERS.find((x) => x.username === username);
  if (!found) throw new Error('unknown user ' + username);
  return found;
}

export function sum(u2: AdminUser): UserSummary {
  return { handle: u2.username, nickname: u2.nickname, avatar: null, role: u2.role, title: u2.title };
}

// 分区（DB §4.2 boards：slug/name/description/sort/status/cover_hash/acl_enabled）
export type AdminBoard = {
  id: string;
  slug: string;
  name: string;
  description: string;
  sort: number;
  status: 'active' | 'archived';
  /** mock 里直接给 public/art 下的文件；真实实现是 cover_hash → /img/{hash} */
  cover_file: string;
  acl_enabled: boolean;
  topic_count: number;
  post_count: number;
  today_count: number;
};

export const BOARDS: AdminBoard[] = [
  { id: 'b_1', slug: 'campaign', name: '自制战役', description: '战役作者发布与讨论', sort: 10, status: 'active', cover_file: 'starcraft/nav-custom_campaign.webp', acl_enabled: true, topic_count: 812, post_count: 9421, today_count: 17 },
  { id: 'b_2', slug: 'resources', name: '资源分享', description: '模型、纹理、音效与工具链', sort: 20, status: 'active', cover_file: 'starcraft/nav-tool_dev.webp', acl_enabled: true, topic_count: 431, post_count: 3802, today_count: 9 },
  { id: 'b_3', slug: 'mapping', name: '地图制作', description: '地形、触发与数据编辑', sort: 30, status: 'active', cover_file: 'starcraft/terran.webp', acl_enabled: false, topic_count: 296, post_count: 2140, today_count: 5 },
  { id: 'b_4', slug: 'vanilla', name: '原版模组', description: '不改变平衡性的原版增强', sort: 40, status: 'active', cover_file: 'starcraft/nav-vanilla_mod.webp', acl_enabled: false, topic_count: 88, post_count: 611, today_count: 1 },
  { id: 'b_5', slug: 'announce', name: '公告与活动', description: '站点公告、赛事与活动', sort: 50, status: 'active', cover_file: 'starcraft/nav-announcement.webp', acl_enabled: true, topic_count: 24, post_count: 308, today_count: 2 },
  { id: 'b_6', slug: 'meta', name: '站务讨论', description: '规则、建议与问题反馈', sort: 60, status: 'active', cover_file: 'starcraft/nav-profile.webp', acl_enabled: false, topic_count: 57, post_count: 402, today_count: 0 },
  { id: 'b_7', slug: 'archive', name: '旧版存档', description: '旧站迁移时的历史分区，只读', sort: 70, status: 'archived', cover_file: 'starcraft/protoss.webp', acl_enabled: false, topic_count: 1204, post_count: 8890, today_count: 0 },
];

/** board_acls（D6 的落点）：角色 × 分区的四个开关。key = board_id + ':' + role_id */
export type BoardAcl = {
  board_id: string;
  role_id: string;
  can_post: boolean;
  can_reply: boolean;
  deny_post: boolean;
  deny_reply: boolean;
};

export const BOARD_ACLS: BoardAcl[] = [
  // 自制战役：白名单制——只有 creator 及以上能发帖；user 被明确禁止
  { board_id: 'b_1', role_id: 'r_user', can_post: false, can_reply: true, deny_post: true, deny_reply: false },
  { board_id: 'b_1', role_id: 'r_creator', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
  { board_id: 'b_1', role_id: 'r_admin', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
  // 资源分享：登录即可回复，发帖要 creator
  { board_id: 'b_2', role_id: 'r_user', can_post: false, can_reply: true, deny_post: false, deny_reply: false },
  { board_id: 'b_2', role_id: 'r_creator', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
  // 公告与活动：只有 admin 能发，其它角色连回复都被禁
  { board_id: 'b_5', role_id: 'r_user', can_post: false, can_reply: false, deny_post: true, deny_reply: true },
  { board_id: 'b_5', role_id: 'r_creator', can_post: false, can_reply: false, deny_post: true, deny_reply: true },
  { board_id: 'b_5', role_id: 'r_admin', can_post: true, can_reply: true, deny_post: false, deny_reply: false },
];

export function aclOf(boardId: string, roleId: string): BoardAcl {
  return BOARD_ACLS.find((a) => a.board_id === boardId && a.role_id === roleId)
    ?? { board_id: boardId, role_id: roleId, can_post: false, can_reply: false, deny_post: false, deny_reply: false };
}

/** 分区版主（board_moderators，带期限）。 */
export type BoardModerator = { board_id: string; user: UserSummary; granted_at: string; expires_at: string | null };

export const BOARD_MODERATORS: BoardModerator[] = [
  { board_id: 'b_1', user: sum(u('helper')), granted_at: '2026-04-01T00:00:00Z', expires_at: null },
  { board_id: 'b_1', user: sum(u('oldfriend')), granted_at: '2026-09-01T00:00:00Z', expires_at: '2026-12-01T15:59:59Z' },
  { board_id: 'b_2', user: sum(u('mapmaker')), granted_at: '2026-02-10T00:00:00Z', expires_at: null },
];

/** 帖子审核队列：topics.status ∈ pending / normal / rejected（DB §4.2）。 */
export type ReviewItem = {
  id: string;
  title: string;
  board: { slug: string; name: string };
  kind: 'discussion' | 'resource' | 'repost';
  author: UserSummary;
  author_trusted: boolean;
  created_at: string;
  excerpt: string;
  images: number;
  state: 'pending' | 'normal' | 'rejected';
  review_note: string;
  reviewer: UserSummary | null;
  reviewed_at: string | null;
};

export const REVIEW_QUEUE: ReviewItem[] = [
  {
    id: 'tp_01', title: '【战役】《灰烬余晖》第三章发布，共 12 关', board: { slug: 'campaign', name: '自制战役' },
    kind: 'resource', author: sum(u('mapmaker')), author_trusted: true, created_at: '2026-10-12T11:02:00Z',
    excerpt: '第三章加入了新的指挥官技能树与三个可选支线。安装方式见文末，压缩包内附校验值……',
    images: 4, state: 'pending', review_note: '', reviewer: null, reviewed_at: null,
  },
  {
    id: 'tp_02', title: '关于合作模式 AI 波次缩放的几点想法', board: { slug: 'mapping', name: '地图制作' },
    kind: 'discussion', author: sum(u('chenxi')), author_trusted: false, created_at: '2026-10-12T09:41:00Z',
    excerpt: '我试着把波次数量做成随难度递增的曲线，但发现 8 分钟后的第一波会同时压到两个路口……',
    images: 1, state: 'pending', review_note: '', reviewer: null, reviewed_at: null,
  },
  {
    id: 'tp_03', title: '免费领取优惠券，点击进入', board: { slug: 'meta', name: '站务讨论' },
    kind: 'discussion', author: sum(u('adbot9000')), author_trusted: false, created_at: '2026-10-12T08:15:00Z',
    excerpt: '限时活动，先到先得……',
    images: 0, state: 'pending', review_note: '', reviewer: null, reviewed_at: null,
  },
  {
    id: 'tp_04', title: '【资源】高清地形纹理包 v3（含夜间变体）', board: { slug: 'resources', name: '资源分享' },
    kind: 'resource', author: sum(u('artofwar')), author_trusted: true, created_at: '2026-10-11T20:30:00Z',
    excerpt: '在 v2 基础上重做了 14 张地形贴图，新增夜间变体；体积从 480MB 降到 310MB……',
    images: 6, state: 'pending', review_note: '', reviewer: null, reviewed_at: null,
  },
  {
    id: 'tp_05', title: '启动器 0.7.2 更新说明（外部直链）', board: { slug: 'announce', name: '公告与活动' },
    kind: 'repost', author: sum(u('linkai')), author_trusted: true, created_at: '2026-10-11T02:10:00Z',
    excerpt: '本次更新修复了中文路径导致的校验失败……',
    images: 0, state: 'normal', review_note: '', reviewer: sum(u('tangtian')), reviewed_at: '2026-10-11T02:20:00Z',
  },
  {
    id: 'tp_06', title: '第一次做战役，请大佬看看方向对不对', board: { slug: 'campaign', name: '自制战役' },
    kind: 'discussion', author: sum(u('rookie')), author_trusted: false, created_at: '2026-10-10T16:00:00Z',
    excerpt: '目前做了两关，主要是想让玩家在第二关自己发现基地被渗透……',
    images: 2, state: 'normal', review_note: '', reviewer: sum(u('tangtian')), reviewed_at: '2026-10-10T17:12:00Z',
  },
  {
    id: 'tp_07', title: '出售代练账号，私聊', board: { slug: 'meta', name: '站务讨论' },
    kind: 'discussion', author: sum(u('zergling')), author_trusted: false, created_at: '2026-10-09T12:00:00Z',
    excerpt: '价格好商量……',
    images: 0, state: 'rejected', review_note: '违反站规第 4 条（交易账号），已拒绝并警告作者。',
    reviewer: sum(u('tangtian')), reviewed_at: '2026-10-09T12:30:00Z',
  },
  {
    id: 'tp_08', title: '自制的合作指挥官：斯台特曼改版', board: { slug: 'resources', name: '资源分享' },
    kind: 'resource', author: sum(u('silentsheep')), author_trusted: false, created_at: '2026-10-08T03:00:00Z',
    excerpt: '技能数值还没调好，先发出来征求意见……',
    images: 3, state: 'rejected', review_note: '请补充安装说明与版本号后重新提交。',
    reviewer: sum(u('tangtian')), reviewed_at: '2026-10-08T09:40:00Z',
  },
];

/** 举报（清单 A7：老站有 reports 表，新方案契约有端点但 DB 文档还没有这张表）。 */
export type ReportItem = {
  id: string;
  target_type: 'topic' | 'post' | 'user';
  target_label: string;
  board: { slug: string; name: string } | null;
  reason: 'spam' | 'abuse' | 'illegal' | 'offtopic' | 'other';
  detail: string;
  reporter: UserSummary;
  created_at: string;
  state: 'open' | 'handled' | 'dismissed';
  handler: UserSummary | null;
  handled_at: string | null;
  handle_note: string;
};

export const REPORTS: ReportItem[] = [
  {
    id: 'rp_01', target_type: 'topic', target_label: '免费领取优惠券，点击进入', board: { slug: 'meta', name: '站务讨论' },
    reason: 'spam', detail: '同一个账号在两小时内发了 14 条同样的内容。', reporter: sum(u('chenxi')),
    created_at: '2026-10-12T08:20:00Z', state: 'open', handler: null, handled_at: null, handle_note: '',
  },
  {
    id: 'rp_02', target_type: 'post', target_label: '回复 #42：你这种玩法就是菜', board: { slug: 'campaign', name: '自制战役' },
    reason: 'abuse', detail: '人身攻击，已经不是第一次了。', reporter: sum(u('mapmaker')),
    created_at: '2026-10-12T07:05:00Z', state: 'open', handler: null, handled_at: null, handle_note: '',
  },
  {
    id: 'rp_03', target_type: 'topic', target_label: '【资源】高清地形纹理包 v3（含夜间变体）', board: { slug: 'resources', name: '资源分享' },
    reason: 'illegal', detail: '压缩包里疑似带了其它作者的付费素材。', reporter: sum(u('oldfriend')),
    created_at: '2026-10-11T23:40:00Z', state: 'open', handler: null, handled_at: null, handle_note: '',
  },
  {
    id: 'rp_04', target_type: 'topic', target_label: '启动器 0.7.2 更新说明（外部直链）', board: { slug: 'announce', name: '公告与活动' },
    reason: 'offtopic', detail: '公告区不应该出现下载讨论。', reporter: sum(u('zhangwei')),
    created_at: '2026-10-11T03:00:00Z', state: 'handled', handler: sum(u('tangtian')), handled_at: '2026-10-11T03:30:00Z',
    handle_note: '与作者确认后保留：直链属启动器正式发布内容。',
  },
  {
    id: 'rp_05', target_type: 'user', target_label: '@zergling（小狗快跑）', board: null,
    reason: 'spam', detail: '私信里发外站推广。', reporter: sum(u('chenxi')),
    created_at: '2026-10-10T14:00:00Z', state: 'handled', handler: sum(u('tangtian')), handled_at: '2026-10-10T14:20:00Z',
    handle_note: '已按站规封号（users.status=banned），并记入审计。',
  },
  {
    id: 'rp_06', target_type: 'post', target_label: '回复 #7：这地图也太简单了吧', board: { slug: 'mapping', name: '地图制作' },
    reason: 'abuse', detail: '语气不好但没骂人。', reporter: sum(u('rookie')),
    created_at: '2026-10-09T10:00:00Z', state: 'dismissed', handler: sum(u('helper')), handled_at: '2026-10-09T11:00:00Z',
    handle_note: '不构成违规，驳回举报。',
  },
];

export const REPORT_REASON: Record<ReportItem['reason'], string> = {
  spam: '垃圾广告', abuse: '人身攻击', illegal: '侵权 / 违规内容', offtopic: '与分区主题无关', other: '其它',
};

import { api } from './client';

// 关注（拍板 L5，2026-10-14）：关注分区 / 关注用户。
// **字段名逐字照抄后端 follow.State**（forum/internal/follow/types.go）——
// target / slug / handle / following / follower_count，没有跟随者总数之外的第二个计数。
//
// 两条口径照后端抄，前端不许自己推：
//   · 未登录也能读（following 恒 false，follower_count 照给）—— 分区页那格「成员」游客也要看得到；
//   · 关注/取关是**幂等**的：重复关注返回同一份状态（不是 409），重复取关也是 200 + 同一份状态。
//
// 本客户端只有「分区」这一半的落点（routes/board.tsx 的那颗按钮）。
// 用户那一半的端点（/users/{handle}/follow）与「我关注的」两个列表都已经在服务端，
// 前端落点见 完全重构/进行中/进度-K-REL.md（个人主页的「关注」那颗按钮归 profile/topic 那两个文件）。

/** GET/PUT/DELETE 三个动作的回执形状（同一个 State）。 */
export type FollowState = {
  target: 'board' | 'user';
  slug?: string;
  handle?: string;
  /** **我**有没有关注它。未登录恒 false */
  following: boolean;
  follower_count: number;
};

export function fetchBoardFollow(slug: string, signal?: AbortSignal): Promise<FollowState> {
  return api<FollowState>('boards/' + encodeURIComponent(slug) + '/follow', { signal });
}

export function followBoard(slug: string): Promise<FollowState> {
  return api<FollowState>('boards/' + encodeURIComponent(slug) + '/follow', { method: 'PUT' });
}

export function unfollowBoard(slug: string): Promise<FollowState> {
  return api<FollowState>('boards/' + encodeURIComponent(slug) + '/follow', { method: 'DELETE' });
}

export function fetchUserFollow(handle: string, signal?: AbortSignal): Promise<FollowState> {
  return api<FollowState>('users/' + encodeURIComponent(handle) + '/follow', { signal });
}

export function followUser(handle: string): Promise<FollowState> {
  return api<FollowState>('users/' + encodeURIComponent(handle) + '/follow', { method: 'PUT' });
}

export function unfollowUser(handle: string): Promise<FollowState> {
  return api<FollowState>('users/' + encodeURIComponent(handle) + '/follow', { method: 'DELETE' });
}

/** 「我关注的」列表项：字段名照 follow.BoardItem / follow.UserItem。 */
export type FollowedBoard = { slug: string; name: string; description: string; cover_hash: string; followed_at: string };
export type FollowedUser = {
  id: string;
  handle: string;
  nickname: string;
  /** 裸哈希（与 UserBriefDTO 同一套），URL 由 mappers/avatar 拼 */
  avatar_hash: string;
  avatar_small_hash: string;
  followed_at: string;
};

import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';
import type { Paged, Topic } from './forum';

// 用户域（v2 §21.2 user / title 段）。个人主页是**一个聚合响应**（后端 §20.2 第 17 条）。
//
// 字段名逐字照抄后端 `user.Profile`（forum/internal/user/service.go:52-68）：**是平铺的**。
// 没有 `stats` 子对象，没有 `reply_count` / `follower_count`（后端没有这两个数），也没有 `is_self`
// （「是不是本人」由调用方拿会话 handle 比 —— 接口不该替前端判这个）。
// 2026-10-14 实测 `GET /dev/api/v1/users/demo-drone` 的响应就是这个形状：
// 之前这里按设计稿写成 stats + is_self，于是线上主页三个统计全渲染成「—」、精华/粉丝永远缺。
export type UserProfile = {
  id: string;
  handle: string;
  nickname: string;
  /** /img/<hash>；**空串 = 没有头像**（不是 null），界面按空串回落首字占位 */
  avatar: string;
  avatar_small: string;
  bio: string;
  /** normal | banned | deleted —— deleted 后端直接 404，所以页面见不到它 */
  status: string;
  level: number;
  exp: number;
  exp_max: number;
  topic_count: number;
  /** 收到的赞（只算 status=normal 的帖子，后端 §2.2） */
  like_received: number;
  /** RFC3339 */
  joined_at: string;
  /** **只给佩戴中的那一个**；持有的全部在 GET /users/{handle}/titles */
  title: { name: string; color: string } | null;
};

export function fetchUserProfile(handle: string, signal?: AbortSignal): Promise<UserProfile> {
  return api<UserProfile>('users/' + encodeURIComponent(handle), { signal });
}

export function fetchUserTopics(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('users/' + encodeURIComponent(handle) + '/topics', { query: pageQuery(q), signal });
}

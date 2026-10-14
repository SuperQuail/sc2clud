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

/**
 * 换头像：**全站唯一走 multipart 的请求**（POST /me/avatar，字段名 file）。
 * 服务端按内容哈希落盘、写回 users.avatar_hash，所以同一张图重传是 200 + created:false。
 * 前端在 image-pipeline 里已经压到 ≤64KB（服务端硬上限 128KB，见 media 的配置）。
 */
export function uploadAvatar(file: Blob): Promise<{ hash: string; url: string }> {
  const form = new FormData();
  // 文件名只是给服务端的提示；落盘名按内容哈希算，不是它
  form.append('file', file, 'avatar.webp');
  return api<{ hash: string; url: string }>('me/avatar', { method: 'POST', body: form });
}

/** 移除头像（DELETE /me/avatar）：之后回落到站点默认头像池里分给这个人的那张。 */
export function clearAvatar(): Promise<void> {
  return api<void>('me/avatar', { method: 'DELETE' });
}

export function fetchUserTopics(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('users/' + encodeURIComponent(handle) + '/topics', { query: pageQuery(q), signal });
}

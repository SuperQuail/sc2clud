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
  /** 个人主页封面/背景（0030 的 users.cover_hash）；**空串 = 没设过**，界面回落默认站内素材 */
  cover: string;
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

/**
 * 搜索用户：GET /search?type=users（真源 forum/internal/app/search_endpoint.go:109 →
 * user.Service.Search → user.SearchItem）。
 *
 * **这是第二档搜索的入口**：首页那一块搜索有「帖子 / 用户」两档，帖子档走 forum.ts 的
 * searchTopics()，用户档原先全站没有函数 —— 于是设计稿里的「搜人」在真站上做不出来。
 *
 * 与帖子档的两点不同（照后端抄，不是照设计稿猜）：
 *   · **没有游标**：response 是 { data: SearchItem[] }，没有 next_cursor（用户档不分页，
 *     上限就是 limit=20 —— user/service.go 把 >20 一律夹到 20）；
 *   · **没有条目数量上限之外的契约**：q 必须是 1–32 个字，超长/为空后端返回 400
 *     （apperr.Invalid 的 fields.q），所以调用方不要在 q 为空时发这个请求。
 *
 * avatar 是完整路径 /img/<hash>，可能为空串（该用户没有头像且默认池为空）→ 界面回落首字占位。
 */
export type SearchUser = {
  id: string;
  handle: string;
  nickname: string;
  /** /img/<hash>；**空串 = 没有头像**（与 Profile.avatar 同一条约定）；拼装结果行时换成 null */
  avatar: string | null;
  /** 契约里有 level；**前端没有等级体系**（见 @/ui/user/user-badge 的注释），带着但不渲染 */
  level: number;
  /** 昵称重名：后端让前端用 @handle 区分（user/service.go:83） */
  ambiguous: boolean;
};

/** limit 默认 10、上限 20（maxSearchLimit / user.Search 的同一口径）；这一档没有游标，所以直接要满一页。 */
export function searchUsers(q: string, limit = 20, signal?: AbortSignal): Promise<SearchUser[]> {
  return api<SearchUser[]>('search', { query: { q, type: 'users', limit }, signal });
}

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

/**
 * 换个人主页封面 / 背景（POST /me/cover，字段名 file）—— 拍板 08 第二轮「壁纸替换」。
 * 与头像同一条图片通道（media 域），上限是内容图那一档（2MiB）：封面是横幅，不是 64KiB 的头像。
 */
export function uploadCover(file: Blob): Promise<{ hash: string; url: string; width: number; height: number }> {
  const form = new FormData();
  form.append('file', file, 'cover.webp');
  return api<{ hash: string; url: string; width: number; height: number }>('me/cover', { method: 'POST', body: form });
}

/** 清空封面（DELETE /me/cover）：主页回到默认站内素材（不是一片空白）。 */
export function clearCover(): Promise<void> {
  return api<void>('me/cover', { method: 'DELETE' });
}

export function fetchUserTopics(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('users/' + encodeURIComponent(handle) + '/topics', { query: pageQuery(q), signal });
}

import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';
import type { Paged, Topic } from './forum';

// 用户域（v2 §21.2 user / title 段）。个人主页是**一个聚合响应**（后端 §20.2 第 17 条）。

export type UserProfile = {
  handle: string;
  nickname: string;
  avatar?: string | null;
  bio?: string | null;
  role?: { key: string; name: string } | null;
  title?: { name: string; color?: string | null } | null;
  joined_at?: string | null;
  stats?: { topic_count: number; reply_count: number; like_received: number; follower_count: number };
  /** 头衔（§21.2 title 段：该用户持有的头衔 + 当前佩戴） */
  titles?: Array<{ id: string; name: string; color?: string | null; equipped?: boolean }>;
  /** 看的是不是自己 —— 决定渲染不渲染账号入口（11-profile 那次 bug 的落点） */
  is_self?: boolean;
};

export function fetchUserProfile(handle: string, signal?: AbortSignal): Promise<UserProfile> {
  return api<UserProfile>('users/' + encodeURIComponent(handle), { signal });
}

export function fetchUserTopics(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('users/' + encodeURIComponent(handle) + '/topics', { query: pageQuery(q), signal });
}

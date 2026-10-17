import { assetUrl } from '@/lib/url';
import { formatTime } from '@/lib/format';
import type { TopicRowData } from '@/ui/topic/topic-row';
import { KIND_TAG, TOPIC_KIND_LABEL } from '../14-home/topic-kind';
import { TOPICS, type Topic } from '../14-home/mock';

// DevRoom 19 · 搜索的假数据与筛选。
//
// 契约（forum/internal/app/search_endpoint.go）：
//   GET /api/v1/search?q=&type=topics|users&limit=&cursor=
//   · type=topics → {"data": TopicCardDTO[], "next_cursor": …}
//     **条目与信息流是同一个形状**（同一张卡片，作者/分区/计数都按 id 补），所以这里直接复用
//     14-home 的信息流数据 —— 搜索结果不是第二种帖子，不另造一份假数据。
//   · type=users  → {"data": SearchItem[]}（forum/internal/user/service.go:76）
//     id / handle / nickname / avatar / level / ambiguous；q 长度 1–32，limit 默认 10、上限 20。
//   · **type 不在三值内不静默回落**：后端直接 400（search_endpoint.go 的 default 分支）。
//
// shortcut: 这里退化成子串匹配（后端是 platform/search 的 bigram + tsvector 两档检索）；
// 只为让「换个词就没结果」这种真实行为在房间里演得出来。接真接口时整个 searchTopics 删掉即可。

export function searchTopics(q: string, all: Topic[] = TOPICS): Topic[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [];
  return all.filter((t) => (t.title + ' ' + t.excerpt).toLowerCase().includes(needle));
}

/** 帖子的筛选项不参与搜索；这里只把契约字段映射成主题列表行的形状。 */
export function toTopicRow(topic: Topic, href: string): TopicRowData {
  return {
    id: topic.id,
    title: topic.title,
    tags: [{ text: TOPIC_KIND_LABEL[topic.kind], type: KIND_TAG[topic.kind] }],
    author: { nickname: topic.author.nickname, avatar: topic.author.avatar },
    replies: topic.reply_count,
    views: topic.view_count,
    lastReplyAt: formatTime(topic.last_reply_at),
    href,
  };
}

export type SearchUser = {
  id: string;
  handle: string;
  nickname: string;
  avatar?: string | null;
  /** 契约里有 level；**前端没有等级体系**（@/ui/user/user-badge 的注释），所以这一行只带着它、不渲染 */
  level: number;
  /** 昵称重名：后端让前端用 @handle 区分（user/service.go:83） */
  ambiguous: boolean;
  /** 链接由调用方给（与 TopicRow 同一条约定：组件不认识路由） */
  href?: string;
};

// 昵称重名的两个人故意都叫「陆战队员」：ambiguous=true 的那两位要一眼看出来靠 @handle 区分。
export const USERS: SearchUser[] = [
  { id: 'u_01', handle: 'demo-admin', nickname: '示范管理员', avatar: assetUrl('miyin-portrait-160.webp'), level: 12, ambiguous: false },
  { id: 'u_02', handle: 'demo-marine', nickname: '陆战队员', avatar: assetUrl('miyin-chibi-160.webp'), level: 5, ambiguous: true },
  { id: 'u_03', handle: 'demo-spectre', nickname: '陆战队员', avatar: null, level: 3, ambiguous: true },
  { id: 'u_04', handle: 'demo-zealot', nickname: '狂热者', avatar: assetUrl('miyin/smile-160.webp'), level: 8, ambiguous: false },
  { id: 'u_05', handle: 'demo-battlecruiser', nickname: '大和号', avatar: assetUrl('miyin/genius-160.webp'), level: 4, ambiguous: false },
  { id: 'u_06', handle: 'demo-voidray', nickname: '虚空辉光舰', avatar: null, level: 2, ambiguous: false },
];

/** 前缀候选：handle 或昵称以关键词开头（后端 SearchSQL 就是前缀匹配）。 */
export function searchUsers(q: string, all: SearchUser[] = USERS): SearchUser[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [];
  return all.filter((u) => u.handle.toLowerCase().startsWith(needle) || u.nickname.startsWith(q.trim()));
}

/** 搜索词的口径提示：两档查的东西不同，空态文案要说清「查的是什么」。 */
export const SEARCH_SCOPE: Record<'topics' | 'users', string> = {
  topics: '帖子：标题与正文（后端 bigram + tsvector 的两档检索，不是模糊匹配）',
  users: '用户：昵称或登录名的前缀（q 长度 1–32，一页最多 20 条）',
};

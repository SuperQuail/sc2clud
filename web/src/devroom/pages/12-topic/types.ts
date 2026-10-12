import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';

// 12-topic 页面内的假数据形状。
// **字段名照 完全重构/论坛后端技术方案-v2.md 第 21 章**（详情页在列表项字段之上再加
// content_md / content_html / sources[] / images[]；点赞收藏状态在 viewer 里）。
// 新增的字段（维护状态、作者卡片统计、收款渠道）在文件末尾集中列出，回报里同步给 Lead。

export type BoardSlug = 'announcement' | 'vanilla-mod' | 'custom-campaign' | 'tool-player' | 'tool-dev';

/** GET /api/v1/boards —— 左栏的分区列表项 */
export type Board = {
  slug: BoardSlug;
  name: string;
  cover: string;
  description: string;
  topic_count: number;
  post_count: number;
  member_count: number;
  today_count: number;
  joined: boolean;
  /** 左栏悬停提示里的一句话定位 */
  hint: string;
};

/** 分区内导航（全部/精华/资源/讨论/公告）——URL 上的 kind/featured 组合 */
export type BoardNav = { key: string; label: string; count: number };

/** GET /api/v1/topics/{id} 里的 sources[] —— 资源帖的下载来源 */
export type TopicSource = {
  id: string;
  /** netdisk = 网盘；github = 代码托管 */
  provider: 'netdisk' | 'github';
  label: string;
  /** 302 转链按钮指向的端点，形如 /api/v1/topics/{id}/sources/{sid}/go */
  go_path: string;
  extraction_code?: string | null;
  size: string;
  verified_at: string;
  /** 维护状态：作者仍在跟进 / 已归档不再更新 */
  upkeep: 'active' | 'archived';
};

export type TopicKind = 'discussion' | 'resource' | 'repost';

/** GET /api/v1/topics/{id} */
export type TopicDetail = {
  id: string;
  board: { slug: BoardSlug; name: string };
  kind: TopicKind;
  title: string;
  /** 后端已用 bluemonday 清洗过的富文本 */
  content_html: string;
  author: TopicAuthor;
  created_at: string;
  updated_at: string;
  reply_count: number;
  like_count: number;
  view_count: number;
  bookmark_count: number;
  pinned: boolean;
  featured: boolean;
  locked: boolean;
  sources: TopicSource[];
  images: string[];
  viewer: { liked: boolean; bookmarked: boolean; following: boolean };
};

/** 发帖者卡片需要的东西（列表项里的 author 只剩三字段，这里是详情页的展开） */
export type TopicAuthor = {
  handle: string;
  nickname: string;
  avatar: string;
  role: { key: string; name: string } | null;
  title: { name: string; color: string } | null;
  bio: string;
  level: number;
  /** 当前等级内已获得的经验 */
  exp: number;
  /** 升到下一级所需经验 */
  exp_max: number;
  topic_count: number;
  like_received: number;
  joined_at: string;
};

/** GET /api/v1/users/{handle}/channels —— 收款码（作者侧开关关着时后端返回空数组） */
export type PaymentChannel = {
  id: string;
  /** 后端只回 /img/<hash>，前端不接收任何凭据 */
  qr_url: string;
  label: string;
  notice: string;
};

export type TopicPageData = {
  me: { nickname: string; avatar: string };
  board_nav: BoardNav[];
  topic: TopicDetail;
  comments: CommentData[];
  comment_total: number;
  candidates: MentionCandidate[];
  channels: PaymentChannel[];
  /** 未关闭的 Issue 数 —— 顶栏 Issue 按钮上的计数 */
  issue_open_count: number;
};

import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';

// 12-topic 页面内的假数据形状。
// **字段名照 完全重构/论坛后端技术方案-v2.md 第 21 章**（详情页在列表项字段之上再加
// content_md / content_html / sources[] / images[]；点赞收藏状态在 viewer 里）。
// 新增的字段（维护状态、作者卡片统计、收款渠道）在文件末尾集中列出，回报里同步给 Lead。

export type BoardSlug = 'announcement' | 'vanilla-mod' | 'custom-campaign' | 'tool-player' | 'tool-dev';

/** GET /api/v1/boards —— 左栏的分区列表项。
 *  封面字段是后端 BoardDTO 的 **cover_hash**（裸哈希，不是路径；forum/internal/forum/dto.go:43）——
 *  与 03-navigation BoardRail 的 BoardSummary 同一个字段名，所以 Board 也直接能当左栏那份数据用。 */
export type Board = {
  slug: BoardSlug;
  name: string;
  cover_hash: string;
  description: string;
  topic_count: number;
  post_count: number;
  member_count: number;
  today_count: number;
  joined: boolean;
  /** 左栏悬停提示里的一句话定位 */
  hint: string;
};

/** 分区内导航（全部/精华/资源/讨论/公告）——URL 上的 kind/featured 组合。
 *  count 可缺：后端没有「每个筛选各有多少帖」这个数，真站只能先不给（给了 0 会被当成「这里没有帖子」）。 */
export type BoardNav = { key: string; label: string; count?: number };

/** GET /api/v1/topics/{id} 里的 sources[] —— 资源帖的下载来源 */
export type TopicSource = {
  id: string;
  /** **开放集合**：词表只有两处 —— 后端 forum/internal/forum/sources.go 的 switch 与
   *  lib/api/forum.ts 的 SOURCE_PROVIDERS（12 个）。设计件不认业务词，只按它挑图标；
   *  认不出的（含房间里老站的 netdisk）一律回落成通用图标 + 来源自己的 label。 */
  provider: string;
  label: string;
  /** 302 转链按钮指向的端点，形如 /api/v1/topics/{id}/sources/{sid}/go */
  go_path: string;
  /** 服务端存的原始链接（SourceDTO.url）：作者没写 label 时，行里拿它的主机名让这条源可辨认 */
  url?: string;
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
  /** 正文的**真源**：Lexical EditorState 的 JSON（后端字段名就是 content_md）。
   *  编辑弹层要把它灌回 MarkdownEditor —— 从 content_html 反推不回编辑器状态
   *  （会丢提及的 userId 与图片节点），所以详情必须带上它。 */
  content_md: string;
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
  /** 颜色可缺省：后端 title.color 允许为空，TitleBadge 自己会回落到主题色 */
  title: { name: string; color?: string | null } | null;
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

/** GET /api/v1/users/{handle}/channels 的形状在 @/lib/api/rewards（那里是契约的唯一一份）。
 *  这里曾有一份本地声明，用的是设计稿的 `qr_url` + 每渠道 `notice` —— **后端两个都没有**：
 *  图叫 `image`、提示是 `user_donation_settings.notice_text`（全局一句，不是每渠道一句）。 */
import type { PaymentChannel } from '@/lib/api/rewards';

export type { PaymentChannel };

/** 本页自己记账用的两条（DevRoom 演示，不在后端契约里）：
 *  newCommentSeqs 是「发布」后新插进来的那几条的序号，用来把「最新」排序与新回复置顶做出来
 *  （mock 的 createdAt 是「3 小时前」这种展示串，排不了序）。删掉那条评论时序号也一并清掉。 */
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
  /** 新发的评论：id → 序号（越大越新）。渲染时读它决定排序与置顶 */
  newCommentSeqs?: Record<string, number>;
};

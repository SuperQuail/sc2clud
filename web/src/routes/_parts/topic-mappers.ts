// 帖子页的 DTO → 设计件形状映射（**字段名一律照 forum/internal/forum/dto.go 与 lib/api 的声明抄**）。
//
// 为什么单拆这一份：routes/topic.tsx 在 gate:size 的登记里写着「拆出弹层与动作条到 routes/topic/，
// 行数只减不增」——宿主该留的只有「取数 + 传参」，这一层是纯函数：不认识 React、不认识路由、也不发请求
// （与 _parts/mappers.ts、_parts/issues-mappers.ts 同一个位置）。
import { appPath } from '@/lib/url';
import { formatTime } from '@/lib/format';
import type { Board as ApiBoard, TopicDetail as ApiTopicDetail, TopicSource as ApiSource } from '@/lib/api/forum';
import type { SearchUser, UserProfile } from '@/lib/api/user';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { Board, BoardSlug, TopicAuthor, TopicDetail, TopicSource } from '@/devroom/pages/12-topic/types';
import type { TopicReview } from '@/devroom/pages/12-topic/topic-view';
import { imageUrl } from './mappers';

/** 后端详情里 lib/api/forum.ts 的 TopicDetail **还没声明**的审核/反馈态字段（照 dto.go 抄）。 */
export type TopicWire = {
  review_state?: string;
  review_pending_human?: boolean;
  review_note?: string | null;
  issue_open_count?: number;
  can_edit?: boolean;
  can_reply?: boolean;
  revision_of?: { content_md: string; content_html: string; approved_at: string } | null;
};

/** 主题详情 + 作者资料 → 设计件的 TopicAuthor。
 *  两处字段名都是**实测**的：论坛的 UserBriefDTO 回 avatar_hash（裸哈希），
 *  用户域 user.Profile 回的是平铺的 level/exp/exp_max/topic_count/like_received/joined_at/title。 */
export function toDesignAuthor(t: ApiTopicDetail, ap?: UserProfile): TopicAuthor {
  return {
    handle: t.author.handle,
    nickname: t.author.nickname,
    // 裸哈希没有 URL，统一走 mappers.imageUrl 拼 /img/<hash>；没有哈希就是空串（UserAvatar 自己回落首字母）
    avatar: imageUrl(t.author.avatar_hash) ?? '',
    // 角色徽标：详情会带 role（UserBriefDTO.Role，只有详情那条查询选这三列）。
    // 没带就是 null（列表项路径没有徽标位），不编一个默认角色出来。
    role: t.author.role ?? null,
    title: ap?.title ?? t.author.title ?? null,
    bio: ap?.bio ?? t.author.bio ?? '',
    level: ap?.level ?? t.author.level ?? 1,
    exp: ap?.exp ?? 0,
    exp_max: ap?.exp_max ?? 1,
    topic_count: ap?.topic_count ?? 0,
    like_received: ap?.like_received ?? 0,
    // 两处接口给的都是 RFC3339，而作者卡上那一行是「2024 年 3 月加入」——
    // 不过这一手就会在真站上显示成「2024-03-02T00:00:00Z加入」（个人主页 routes/profile.tsx:372
    // 早就在做同一件事，是帖子页漏了）。
    joined_at: joinedMonth(ap?.joined_at ?? t.author.joined_at ?? ''),
  };
}

/** 「2024 年 3 月」：与 routes/profile.tsx 的 joinedText 同一口径（那里带「加入」两字，这里不带）。 */
function joinedMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(d);
}

/** 主题详情 → 设计件的 TopicDetail（时间在这一步变成展示串）。 */
export function toDesignTopic(t: ApiTopicDetail, author: TopicAuthor): TopicDetail {
  return {
    id: t.id,
    board: { slug: t.board.slug as BoardSlug, name: t.board.name },
    kind: t.kind,
    title: t.title,
    // 正文真源（编辑弹层用）；后端字段名就是 content_md，缺了给空串（编辑器会是空文档）
    content_md: t.content_md ?? '',
    content_html: t.content_html,
    author,
    created_at: formatTime(t.created_at),
    updated_at: formatTime(t.updated_at),
    reply_count: t.reply_count,
    like_count: t.like_count,
    view_count: t.view_count,
    bookmark_count: 0,
    pinned: t.pinned,
    // 详情与列表项都叫 featured（TopicCardDTO.Featured 是 bool）
    featured: t.featured,
    locked: t.locked ?? false,
    sources: (t.sources ?? []).map(toDesignSource),
    images: t.images ?? [],
    viewer: { liked: t.viewer?.liked ?? false, bookmarked: t.viewer?.bookmarked ?? false, following: false },
  };
}

/** 审核态：review_state 只有 pending / approved / rejected 三个值（migrations 的 CHECK）。 */
export function toReview(t: ApiTopicDetail): TopicReview {
  const raw = t as ApiTopicDetail & TopicWire;
  return {
    state: (raw.review_state ?? 'approved') as TopicReview['state'],
    // L6：打回修改时那一份「最后过审版本」。**没有就不造假**（后端也只在第四态给）。
    revision: raw.revision_of ? { content_html: raw.revision_of.content_html, approved_at: raw.revision_of.approved_at } : null,
    // 「已转人工」那一档：后端按 review_events 最新一条判定算（只有作者视角才有意义，读者恒 false）。
    // 缺失时按 false 读 = 「正在自动检查」—— 那正是没有这条信息时该说的话。
    pendingHuman: raw.review_pending_human ?? false,
    note: raw.review_note ?? null,
  };
}

/** 提及候选：后端 `SearchItem` → 编辑器吃的 `MentionCandidate`。
 *  **id 直接用**（后端已经是数字 user id，就是 `mention:<id>` 里那个真源）；
 *  avatar 后端已经拼成 `/img/<hash>`（与个人主页同一条约定），别再套一层 imageUrl；
 *  ambiguous（后端按显示名判的重名）就是编辑器要的 duplicate 标记。 */
export function toMentionCandidates(items: SearchUser[]): MentionCandidate[] {
  return items.map((u) => ({
    id: String(u.id),
    handle: u.handle,
    nickname: u.nickname,
    avatar: u.avatar,
    duplicate: u.ambiguous,
  }));
}

/** 后端回的是 /api/v1/...（不带 /dev 前缀），必须过 appPath 才能同时活在 / 与 /dev/ 两个前缀下。 */
export function toDesignSource(s: ApiSource): TopicSource {
  return {
    id: s.id,
    // 开放集合：词表在后端 sources.go 与 lib/api/forum 的 SOURCE_PROVIDERS，设计件按它挑图标
    provider: s.provider,
    label: s.label,
    go_path: appPath(s.go_path),
    extraction_code: s.extraction_code ?? null,
    size: s.size ?? '',
    verified_at: s.verified_at ? formatTime(s.verified_at) : '未核对',
    upkeep: s.upkeep === 'archived' ? 'archived' : 'active',
  };
}

/** GET /boards 的一行 → 设计件的 Board。
 *  member_count 与 joined **不在这里填**（BoardDTO 没有这两列：成员数就是关注数，
 *  它来自 GET /boards/{slug}/follow，由宿主只对当前这一个分区取一次再覆盖上去）——
 *  所以这里给的是「没有关注信息时」的中性值，不是假数。 */
export function toDesignBoard(b: ApiBoard): Board {
  // 封面字段名照后端 BoardDTO 的 **cover_hash**（裸哈希，dto.go:43）：lib/api/forum.ts 的 Board 还停在
  // 上一次收口的 `cover`（I5 那类欠账），所以两个形状都接着 —— 线上走的是 cover_hash 那半边。
  // 旧行为读的是 b.cover，而 BoardDTO 里没有这一列 → 帖子页的分区封面恒为空（D21）。
  const raw = b as ApiBoard & { cover?: string | null; cover_hash?: string };
  return {
    slug: b.slug as BoardSlug,
    name: b.name,
    cover_hash: raw.cover_hash ?? raw.cover ?? '',
    description: b.description,
    topic_count: b.topic_count,
    post_count: b.post_count ?? 0,
    member_count: b.member_count ?? 0,
    today_count: b.today_count ?? 0,
    // shortcut: hint 那句话后端没有（左栏悬停提示），要真话得后端给
    joined: false,
    hint: '',
  };
}

/** 分区页地址。宿主（routes/topic.tsx）拿它当 TopicView 的 boardHref —— 组件不认识路由。 */
export function boardHref(slug: BoardSlug): string {
  return appPath('b/' + encodeURIComponent(slug));
}

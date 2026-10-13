import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';

/** 列表端点的返回形状（client.ts 的 apiPage 统一解包络） */
export type Paged<T> = { items: T[]; next: string | null };

// 论坛域的端点与响应形状（v2 §21.2 forum 段 / §21.3 示例）。
// 这一层**只声明形状与发请求**：不认识路由、不认识 React（前端方案 §4.1 的依赖方向）。

export type TopicKind = 'discussion' | 'resource' | 'repost';

export type BoardRef = { slug: string; name: string };

export type BoardStatistics = {
  topic_count: number;
  post_count: number;
  member_count: number;
  today_count: number;
};

/** GET /api/v1/boards —— 分区列表（含 cover、topic_count） */
export type Board = BoardRef & {
  description: string;
  /** /img/<hash>；后端可能给 null，界面要能没有封面 */
  cover: string | null;
  topic_count: number;
  post_count?: number;
  member_count?: number;
  today_count?: number;
};

/** GET /api/v1/boards/{slug} —— 分区详情 */
export type BoardDetail = Board & {
  statistics?: BoardStatistics;
  acl_enabled?: boolean;
};

/** 列表项里的作者（§21.3 的 author 只有三字段，详情页才展开） */
export type TopicAuthorSummary = {
  handle: string;
  nickname: string;
  avatar?: string | null;
  role?: { key: string; name: string } | null;
  title?: { name: string; color?: string | null } | null;
};

/** GET /api/v1/topics 的列表项（§21.3 逐字） */
export type Topic = {
  id: string;
  board: BoardRef;
  kind: TopicKind;
  title: string;
  author: TopicAuthorSummary;
  reply_count: number;
  like_count: number;
  view_count: number;
  featured_at: string | null;
  pinned: boolean;
  created_at: string;
  last_reply_at: string | null;
  cover?: string | null;
  viewer?: { liked: boolean; bookmarked: boolean };
  /**
   * 摘要。**§21.3 的列表项没有这个字段**（卡片与紧凑列表都要它）——
   * 已作为后端需求变动挂着（完全重构/界面施工-后端需求变动.md §4.1「列表项补 excerpt」）。
   * 后端补上之前：列表页拿不到就退化成不显示摘要，不做「前端拉全文再截断」那件事（那会把正文拖进列表响应）。
   */
  excerpt?: string | null;
};

/** GET /api/v1/topics/{id} 的详情：列表项之上再加正文、来源、图与展开的作者 */
export type TopicDetail = Topic & {
  content_md?: string | null;
  content_html: string;
  updated_at: string;
  bookmark_count?: number;
  locked?: boolean;
  featured?: boolean;
  images?: string[];
  sources?: TopicSource[];
  author: TopicAuthorSummary & { bio?: string | null; level?: number; joined_at?: string | null };
};

export type TopicSource = {
  id: string;
  provider: 'netdisk' | 'github';
  label: string;
  go_path: string;
  extraction_code?: string | null;
  size?: string;
  verified_at?: string | null;
  upkeep?: 'active' | 'archived';
};

/** GET /api/v1/topics/{id}/posts —— 回复（每条含 parent_id、点赞数、我的投票） */
export type Post = {
  id: string;
  parent_id: string | null;
  author: TopicAuthorSummary;
  content_html: string;
  like_count: number;
  dislike_count?: number;
  created_at: string;
  /** 我的投票：0 = 没投，1 / -1 = 投过 */
  viewer?: { value: 0 | 1 | -1 };
};

export type TopicFilter = {
  board?: string;
  kind?: string;
  sort?: 'latest' | 'new' | 'hot';
  q?: string;
} & PageQuery;

export function fetchBoards(signal?: AbortSignal): Promise<Board[]> {
  return api<Board[]>('boards', { signal });
}

export function fetchBoard(slug: string, signal?: AbortSignal): Promise<BoardDetail> {
  return api<BoardDetail>('boards/' + encodeURIComponent(slug), { signal });
}

/** 列表：next 是 UI「还有没有下一页」的唯一依据（null = 到底） */
export function fetchTopics(f: TopicFilter, signal?: AbortSignal): Promise<Paged<Topic>> {
  const { board, kind, sort, q, ...page } = f;
  return apiPage<Topic>('topics', { query: { board, kind, sort, q, ...pageQuery(page) }, signal });
}

export function fetchTopic(id: string, signal?: AbortSignal): Promise<TopicDetail> {
  return api<TopicDetail>('topics/' + encodeURIComponent(id), { signal });
}

/**
 * 搜索帖子：GET /search?type=topics。
 *
 * 条目形状与列表项**完全相同**（同一张卡片），所以首页可以把信息流直接换成搜索结果、共用一套渲染。
 * 游标是不透明的（服务端按 (rank, id) 编的，与列表的 (时间, id) 不是一回事）—— 前端只原样带回。
 */
export function searchTopics(q: string, cursor?: string | null, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('search', { query: { q, type: 'topics', cursor: cursor ?? undefined }, signal });
}

export function fetchPosts(topicId: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Post>> {
  return apiPage<Post>('topics/' + encodeURIComponent(topicId) + '/posts', { query: pageQuery(q), signal });
}

// **字段名是 `board`，值是 slug** —— 不是 `board_id`。
//
// 2026-10-13 盲测实测：这里原本写 `board_id`，而后端 `createTopicBody` 只认 `board` 且 `binding:"required"`，
// 于是「发帖」按钮按下去**必然 400**（fields.board「不能为空」），UI 上发帖 100% 失败。
// 与 D2/D11 同族：契约两侧各写一份，各自的测试都过。
export function createTopic(body: {
  board: string;
  kind: TopicKind;
  title: string;
  content_md: string;
}): Promise<TopicDetail> {
  return api<TopicDetail>('topics', { method: 'POST', body });
}

export function createPost(topicId: string, body: { content_md: string; parent_id?: string }) {
  return api<Post>('topics/' + encodeURIComponent(topicId) + '/posts', { method: 'POST', body });
}

/** 点赞是幂等的 PUT / DELETE（v2 §21.1「幂等」一行） */
export function setTopicLike(id: string, on: boolean) {
  return api<void>('topics/' + encodeURIComponent(id) + '/like', { method: on ? 'PUT' : 'DELETE' });
}

export function setTopicBookmark(id: string, on: boolean) {
  return api<void>('topics/' + encodeURIComponent(id) + '/bookmark', { method: on ? 'PUT' : 'DELETE' });
}

/** 回复的赞/踩：value 只可能是 1 或 -1 */
export function setPostVote(id: string, value: 1 | -1 | 0) {
  return api<void>('posts/' + encodeURIComponent(id) + '/vote', {
    method: value === 0 ? 'DELETE' : 'PUT',
    body: value === 0 ? undefined : { value },
  });
}

// ---- 以下七个是盲测发现「接口都在、前端连函数都没有」之后补的（2026-10-13）----
// 缺它们时用户体感是：**发错了删不掉、看到违规内容没法举报、收藏了找不回来**。

/** 请求体字段与后端 updateTopicBody 逐字对应（title / content_md / board / kind / resource_status，全部可选）。 */
export function updateTopic(id: string, body: { title?: string; content_md?: string }): Promise<TopicDetail> {
  return api<TopicDetail>('topics/' + encodeURIComponent(id), { method: 'PATCH', body });
}

export function deleteTopic(id: string): Promise<null> {
  return api<null>('topics/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 后端 updatePostBody 只有 content_md，且 required。 */
export function updatePost(id: string, contentMd: string): Promise<Post> {
  return api<Post>('posts/' + encodeURIComponent(id), { method: 'PATCH', body: { content_md: contentMd } });
}

export function deletePost(id: string): Promise<null> {
  return api<null>('posts/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 举报事由的值域**只**声明在后端 DTO 的 binding tag 里（`oneof=spam abuse illegal offtopic other`），
 *  改一边就要改另一边 —— report 域有契约测试盯着它。 */
export type ReportReason = 'spam' | 'abuse' | 'illegal' | 'offtopic' | 'other';
export type ReportTargetType = 'topic' | 'post' | 'user';

export function createReport(body: {
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  detail?: string;
}): Promise<{ id: string }> {
  // 重复举报后端回 200 + 既有那条（拍板 §8.11 U5），不当错误处理。
  return api<{ id: string }>('reports', { method: 'POST', body });
}

export function fetchMyBookmarks(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Topic>> {
  return apiPage<Topic>('me/bookmarks', { query: pageQuery(q), signal });
}

/** 我发出的举报：state 是 open | handled | dismissed。 */
export type MyReport = {
  id: string;
  target_type: ReportTargetType;
  target_title: string;
  reason: ReportReason;
  state: 'open' | 'handled' | 'dismissed';
  handle_note?: string | null;
  created_at: string;
};

export function fetchMyReports(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<MyReport>> {
  return apiPage<MyReport>('me/reports', { query: pageQuery(q), signal });
}

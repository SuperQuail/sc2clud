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

/** 列表项里的作者 —— 字段名照 UserBriefDTO（forum/internal/forum/dto.go:12）：头像是**裸哈希**。 */
export type TopicAuthorSummary = {
  handle: string;
  nickname: string;
  /** 裸哈希，字节走 GET /img/<hash>（用 @/routes/_parts/mappers 的 imageUrl 拼）。
   *  两根头像列在 SQL 里就回落过 default_avatar_hash，所以这里拿到的是「有就用」。 */
  avatar_hash?: string | null;
  avatar_small_hash?: string | null;
  /**
   * 基线角色。**只有主题详情才下发这一列**（`UserBriefDTO.Role`，拍板 08 §第三轮 3）：
   * 列表项与楼层上的作者没有徽标位，后端不为每一行多查一次角色 —— 所以它是可选的，
   * 别拿它当「这个人没有角色」。
   * `badge_color` 是 roles.badge_color（可为 null，界面回落主题色）。
   */
  role?: { key: string; name: string; badge_color?: string | null } | null;
  title?: { name: string; color?: string | null } | null;
};

/**
 * GET /api/v1/topics 的列表项 —— **字段名逐字照 TopicCardDTO**（forum/internal/forum/dto.go:41）。
 *
 * 2026-10-14 收口：这个类型原先停在设计稿的名字上（cover / featured_at / author.avatar），
 * 线上返回的却是 cover_hash / featured / avatar_hash（实测 /dev/api/v1/topics），
 * 于是 routes/_parts/mappers.ts 与 routes/topic.tsx 各自声明一份局部类型 + `as` 兜着。
 * 现在声明里就是真名字，那两处局部类型都删了 —— 读代码的人不用再猜哪个名字是真的。
 *
 * 注意 cover_hash / avatar_hash 都是**裸哈希**，URL 由 mappers 的 imageUrl 拼。
 * excerpt 后端**早就有**（TopicCardDTO.Excerpt），别再照 §21.3 说它缺。
 */
export type Topic = {
  id: string;
  board: BoardRef;
  kind: TopicKind;
  title: string;
  /** 摘要，列表项自带（TopicCardDTO.Excerpt） */
  excerpt: string;
  author: TopicAuthorSummary;
  reply_count: number;
  like_count: number;
  view_count: number;
  pinned: boolean;
  /** 精华：DTO 给的是 bool（不是设计稿的 featured_at 时间戳） */
  featured: boolean;
  locked?: boolean;
  cover_hash?: string | null;
  cover_width?: number;
  cover_height?: number;
  created_at: string;
  last_reply_at: string | null;
  viewer?: { liked: boolean; bookmarked: boolean };
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
  /** provider 是开放小集合，词表只有一处：SOURCE_PROVIDERS（对应后端 sources.go 的 switch） */
  provider: SourceProvider;
  label: string;
  go_path: string;
  /** 服务端存的原始链接：只在「编辑来源」时回填输入框（读者点的是 go_path，走 302 计数） */
  url: string;
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
  /** 1 楼是主楼本身（正文区已经有了）；评论区靠它把主楼挡在列表外（D71 双保险），老响应可以没有 */
  floor?: number;
  /**
   * 我的投票：0 = 没投，1 = 赞，-1 = 踩。
   *
   * 2026-10-14 修：这里原本声明成 `viewer?: { value }`，**线上根本没有 viewer 这个字段** ——
   * 真源是 forum/internal/forum/dto.go:131 的 `json:"my_vote"`（map.go:141 逐字赋值）。
   * 后果是评论区「已赞 / 已踩」恒为假：点过的赞再点一次不是取消而是又投一次，而且**不报错**。
   */
  my_vote: number;
};

export type TopicFilter = {
  board?: string;
  kind?: string;
  /**
   * 真源 `forum/internal/forum/dto.go` 的 parseTopicSort：**latest / new / hot** 三个值。
   * `hot` 是 2026-10-14（拍板 §L2）后端补的：`score = (like_count + 3*顶层评论数) * time_boost`
   * （一周内有互动 ×1.5）。它的游标键**不是时间**，由服务端算好（`pgsql.hotScoreSQL` +
   * `forum/cursor.go` 的 `hotCursor`）—— 前端只透传 `sort=hot` 与 `cursor`，别自己拼游标或算热度。
   */
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

/** 置顶 / 精华是版主动作（同一个权限点 topic.pin，路由在 forum/handler.go:90-91）；体字段照 pinBody / featureBody */
export function setTopicPinned(id: string, on: boolean) {
  return api<void>('topics/' + encodeURIComponent(id) + '/pin', { method: 'POST', body: { pinned: on } });
}

export function setTopicFeatured(id: string, on: boolean) {
  return api<void>('topics/' + encodeURIComponent(id) + '/feature', { method: 'POST', body: { featured: on } });
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

/** 请求体字段与后端 updateTopicBody 逐字对应（title / content_md / board / kind / resource_status，全部可选）。
 *
 *  **回执不是帖子详情**：`forum/handler.go` 的 updateTopic 回的是 `{ok:true}`。
 *  2026-10-15 实测的缺陷：这里原来声明 `Promise<TopicDetail>`，调用方拿 `t.id` 拼跳转路径 →
 *  `t.id === undefined` → 跳到 `/t/undefined` → 路径闸（httpx.ValidPathIDs）判成 400「参数错误」。
 *  保存后要展示什么，用**请求里已经知道的那个 id**（编辑态就是 editId）去取。 */
export function updateTopic(id: string, body: { title?: string; content_md?: string; board?: string }): Promise<void> {
  return api<{ ok: boolean }>('topics/' + encodeURIComponent(id), { method: 'PATCH', body }).then(() => undefined);
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
/** 值域照后端 report 域的 binding：topic | post | user | **issue**（issue 是 2026-10-16 加的那一档，
 *  target_id 是 issue 的 public_id）。多一档就多一处与本表的对照，别在别处另写联合类型。 */
export type ReportTargetType = 'topic' | 'post' | 'user' | 'issue';

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
  /** 真源 forum/internal/report/dto.go:10 的 `target_label`（2026-10-14 修：原写 target_title -> 每行标题恒空白） */
  target_label: string;
  reason: ReportReason;
  state: 'open' | 'handled' | 'dismissed';
  handle_note?: string | null;
  created_at: string;
};

export function fetchMyReports(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<MyReport>> {
  return apiPage<MyReport>('me/reports', { query: pageQuery(q), signal });
}

// ---- 下载来源（资源帖）----
//
// 端点与形状对着后端抄：POST/PATCH/DELETE /api/v1/topics/{id}/sources[/{sid}]，
// DTO 是 forum/internal/forum/dto.go 的 SourceDTO（读）与 handler.go 的 sourceBody（写，见下）。
//
// provider 是**开放小集合**：词表只有后端一处 —— forum/internal/forum/sources.go validSourceInput 的
// switch。写错一个词不是「回落成通用图标」，而是**400 fields.provider**，所以这里把同一份词表列出来，
// 18-compose 的编辑器用它出下拉（老库的 123pan/direct 在新站叫 pan123/website）。
export const SOURCE_PROVIDERS = [
  'baidu',
  'aliyun',
  'quark',
  'lanzou',
  'pan123',
  'weiyun',
  'onedrive',
  'mega',
  'website',
  'github',
  'gitee',
  'other',
] as const;

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

/**
 * 新增 / 修改下载源的请求体，逐字对应后端 sourceBody：
 * provider 与 url 是 required（后端 binding），**PATCH 也是整条替换**（后端 updateSource 走的是同一个 body），
 * 所以编辑时这些字段都要带上，不是「只发改过的那几个」。
 *
 * 注意 sourceBody **没有 upkeep**（归档字段后端没从 binding 开出来，见 sources.go 的注释与实现不一致），
 * 所以归档来源在界面上是只读信息，不是可改的开关。extraction_code 传 null = 没有提取码。
 */
export type SourceInput = {
  provider: SourceProvider;
  url: string;
  label?: string;
  extraction_code?: string | null;
  size?: string;
};

export function fetchSources(topicId: string, signal?: AbortSignal): Promise<TopicSource[]> {
  return api<TopicSource[]>('topics/' + encodeURIComponent(topicId) + '/sources', { signal });
}

export function createSource(topicId: string, body: SourceInput): Promise<TopicSource> {
  return api<TopicSource>('topics/' + encodeURIComponent(topicId) + '/sources', { method: 'POST', body });
}

export function updateSource(topicId: string, sourceId: string, body: SourceInput): Promise<TopicSource> {
  return api<TopicSource>('topics/' + encodeURIComponent(topicId) + '/sources/' + encodeURIComponent(sourceId), {
    method: 'PATCH',
    body,
  });
}

/** 真删（后端 DELETE 是物理删除）：填错、重复了才用；归档走 UpdateSource 的 upkeep。 */
export function deleteSource(topicId: string, sourceId: string): Promise<null> {
  return api<null>('topics/' + encodeURIComponent(topicId) + '/sources/' + encodeURIComponent(sourceId), {
    method: 'DELETE',
  });
}

/** 「我确认它还有效」：verified_at 与 upkeep 一起变（后端 §7.3），要作者显式点一次。 */
export function verifySource(topicId: string, sourceId: string): Promise<{ ok: boolean }> {
  const path = 'topics/' + encodeURIComponent(topicId) + '/sources/' + encodeURIComponent(sourceId) + '/verify';
  return api<{ ok: boolean }>(path, { method: 'POST' });
}

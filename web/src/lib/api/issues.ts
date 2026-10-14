import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';
import type { BoardRef, Paged, TopicAuthorSummary } from './forum';

// 问题反馈（后端 post_issues）的端点与响应形状。
// **字段名逐字照后端 DTO 抄**，不照 DevRoom 13-issue 的 mock 抄（那张稿用 id 当编号、labels 当标签，
// 都是设计稿的便利命名）：forum/internal/forum/dto.go:157-207 的 IssueDTO / IssueDetailDTO / IssueCommentDTO，
// 请求体照 handler.go:560-652 的 listIssuesQuery / createIssueBody / updateIssueBody / createCommentBody。
// 这一层只声明形状与发请求：不认识路由、不认识 React（前端方案 §4.1 的依赖方向）。

export type IssueKind = 'bug' | 'feature' | 'difficulty' | 'other';
export type IssueStatus = 'open' | 'closed';
/** 后端 parseIssueSort 只认这三个；comments 是聚合排序，**带 cursor 会 400**（issues.go:31 ErrSortUnpageable）。 */
/**
 * `?sort=` 的值域，逐字照 `forum/internal/forum/issues.go:460` 的 `parseIssueSort`：
 * 它收 **updated / created / new / old / comments** 五个名字 ——
 * `new` 是 `created` 的同义别名，`old` 是**升序**（同一列的另一个方向，2026-10-14 J5 补的）。
 * `comments` 是聚合排序，**带 cursor 会 400**（`ErrSortUnpageable`）。
 */
export type IssueSort = 'updated' | 'created' | 'old' | 'comments';

/** IssueDTO：卡片。id 是 public_id（UUID），number 才是帖内编号（界面上显示的 #N）。 */
export type Issue = {
  id: string;
  number: number;
  kind: IssueKind;
  title: string;
  status: IssueStatus;
  author: TopicAuthorSummary;
  assignee: TopicAuthorSummary | null;
  /** 标签。**字段名是 tags**（DevRoom 稿里叫 labels，别照它抄）。 */
  tags: string[];
  comment_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** 单帖列表与全站聚合都带所属主题（dto.go:172-175），反馈页用它显示「来自哪张图」。 */
  topic_id: string;
  topic_title: string;
  board: BoardRef;
};

/** IssueDetailDTO：卡片 + 正文 HTML（**后端不回 body_md**，Markdown 源只在写入时上行）。 */
export type IssueDetail = Issue & { body_html: string };

/** IssueCommentDTO（dto.go:191）：my_vote 是 0 / 1 / -1，与 PostDTO 同款（不是 viewer.value）。 */
export type IssueComment = {
  id: string;
  parent_id: string | null;
  body_html: string;
  author: TopicAuthorSummary;
  like_count: number;
  /**
   * 踩数。**按身份下发**（拍板 §J3）：普通用户与游客的响应里没有这个键（DTO 上带 omitempty），
   * 只有「管理员及以上」与「内容发布者」拿得到 —— 所以它是可选的，别当必填用。
   * 界面侧的对应处理见 `routes/issues.tsx` 的注释（那一格的显示由服务端决定，前端不自己藏）。
   */
  dislike_count?: number;
  my_vote: number;
  created_at: string;
  updated_at: string;
};

export type IssueFilter = {
  status?: IssueStatus;
  kind?: IssueKind;
  /** handle。**后端只接受真实用户**，写错是 404 user.not_found。 */
  author?: string;
  /** 只能传 'me'（handler.go:579 其它值直接 400），且需要登录。 */
  assignee?: 'me';
  sort?: IssueSort;
  /**
   * 检索词（J5）：后端在**标题 + 正文**上做**字面**匹配（不分词，中文两字词天然命中），
   * 上限 100 字、`%` `_` `\` 这些 LIKE 通配符会被 400 挡掉（`issues.go:161` 的守卫）。
   * **必须在服务端搜**：前端只过滤当前一页，翻页前的结果永远搜不到。
   */
  q?: string;
} & PageQuery;

/** 列表参数：GET /issues 与 GET /topics/{id}/issues 共用（后端同一个 listIssuesAt）。 */
function issueQuery(f: IssueFilter): Record<string, string | number | undefined> {
  const { status, kind, author, assignee, sort, q, ...page } = f;
  return { status, kind, author, assignee, sort, q: q?.trim() === '' ? undefined : q, ...pageQuery(page) };
}

/** 全站反馈列表（不限主题）。 */
export function fetchIssues(f: IssueFilter = {}, signal?: AbortSignal): Promise<Paged<Issue>> {
  return apiPage<Issue>('issues', { query: issueQuery(f), signal });
}

/** 单帖反馈列表。传了它就只返回这张图的反馈（反馈页的 ?topic=<id>）。 */
export function fetchTopicIssues(topicId: string, f: IssueFilter = {}, signal?: AbortSignal): Promise<Paged<Issue>> {
  return apiPage<Issue>('topics/' + encodeURIComponent(topicId) + '/issues', { query: issueQuery(f), signal });
}

export function fetchIssue(id: string, signal?: AbortSignal): Promise<IssueDetail> {
  return api<IssueDetail>('issues/' + encodeURIComponent(id), { signal });
}

/** 顶层评论。楼中楼**不在这条响应里** —— 每条要另发 GET /issue-comments/{id}/replies，
 *  而且 IssueCommentDTO 连 reply_count 都没有，所以「哪条有回复」也只能靠那条请求问出来。 */
export function fetchIssueComments(id: string, q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<IssueComment>> {
  return apiPage<IssueComment>('issues/' + encodeURIComponent(id) + '/comments', { query: pageQuery(q), signal });
}

export function fetchIssueCommentReplies(commentId: string, signal?: AbortSignal): Promise<IssueComment[]> {
  return api<IssueComment[]>('issue-comments/' + encodeURIComponent(commentId) + '/replies', { signal });
}

/**
 * 提反馈：POST /topics/{id}/issues。**必须挂在资源帖下面**（service 判 ref.Kind !== 'resource' → forum.not_resource），
 * 所以 topicId 不是可选项。client_token 是重试去重用的（同作者同 token 后端回既有那条，issues.go:220）。
 */
export function createIssue(
  topicId: string,
  body: { kind: IssueKind; title: string; body_md: string; client_token?: string },
): Promise<Issue> {
  return api<Issue>('topics/' + encodeURIComponent(topicId) + '/issues', { method: 'POST', body });
}

/** PATCH /issues/{id}：只有给了的字段才改（指针语义）。开 / 关走 status。 */
export function updateIssue(
  id: string,
  body: { title?: string; body_md?: string; status?: IssueStatus; assignee?: string },
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>('issues/' + encodeURIComponent(id), { method: 'PATCH', body });
}

/** 评论的赞 / 踩：value=0 是「取消」，后端是 DELETE（与 setPostVote 同一套幂等语义）。
 *  返回 VoteResultDTO（dto.go:209）—— 两个计数 + 我的投票，调用方可以直接用它刷新那一条。 */
export function setIssueCommentVote(id: string, value: 1 | -1 | 0): Promise<VoteResult> {
  return api<VoteResult>('issue-comments/' + encodeURIComponent(id) + '/vote', {
    method: value === 0 ? 'DELETE' : 'PUT',
    body: value === 0 ? undefined : { value },
  });
}

/** VoteResultDTO：投票后的计数（拍板 §3：两个计数 + 我的投票）。 */
export type VoteResult = { like_count: number; dislike_count: number; my_vote: number };

/** 发评论：parent_id 非空 = 楼中楼（只允许指向顶层评论，后端保证）。 */
export function createIssueComment(
  id: string,
  body: { body_md: string; parent_id?: string },
): Promise<IssueComment> {
  return api<IssueComment>('issues/' + encodeURIComponent(id) + '/comments', { method: 'POST', body });
}

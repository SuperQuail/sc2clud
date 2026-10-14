import type { TopicAuthorSummary } from '@/lib/api/forum';
import type { Issue, IssueComment as ApiIssueComment } from '@/lib/api/issues';
import type { SearchUser } from '@/lib/api/user';
import { formatTime } from '@/lib/format';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { CommentData } from '@/ui/comment/types';
import type { UserSummary } from '@/ui/user/user-badge';
import type { IssueSummary } from '@/devroom/pages/12-topic/_task/types';
import type { IssueDetail as DesignIssueDetail } from '@/devroom/pages/13-issue/types';
import { imageUrl } from './mappers';

// 反馈页的四个 DTO → 设计件形状的映射（**字段名照 forum/internal/forum/dto.go 抄**）。
// 为什么单拆：routes/issues.tsx 已超过 gate:size 的 500 行上限，而宿主该留的只有「取数 + 传参」；
// 这一层是纯函数：不认识 React、不认识路由、也不发请求（与 _parts/mappers.ts 同一个位置）。
// 命名沿用 routes/issues.tsx 的旧名，调用点一个字都不用改。

/** UserBriefDTO（forum/dto.go:12-17）→ 用户件的 UserSummary。
 *  头像字段是**裸哈希** avatar_hash，不过 imageUrl 换算的话头像全是首字母占位（与 mappers.ts 同一个坑）。 */
export function toIssueUser(u: TopicAuthorSummary): UserSummary {
  // avatar_hash 现在就在 TopicAuthorSummary 上（照 DTO 抄），不用再 as 一层
  return { handle: u.handle, nickname: u.nickname, avatar: imageUrl(u.avatar_hash), role: u.role ?? null, title: u.title ?? null };
}

/** IssueDTO → W1 的 IssueSummary。**两处必换算**（设计稿的便利命名 vs 后端契约）：
 *  id ← number（卡片与详情显示的 #编号；public_id 只用来发请求），标签在详情件里叫 labels 而后端叫 tags。 */
export function toIssueSummary(i: Issue): IssueSummary {
  return {
    id: i.number,
    kind: i.kind,
    status: i.status,
    title: i.title,
    author: toIssueUser(i.author),
    commentCount: i.comment_count,
    createdAt: formatTime(i.created_at),
    updatedAt: formatTime(i.updated_at),
  };
}

/** IssueDTO / IssueDetailDTO → 13-issue 详情面板吃的形状（bodyMarkdown 它不渲染，正文走 bodyHtml）。 */
export function toIssueDesignDetail(i: Issue, bodyHtml: string): DesignIssueDetail {
  return {
    ...toIssueSummary(i),
    bodyMarkdown: '',
    bodyHtml,
    labels: i.tags,
    assignee: i.assignee ? toIssueUser(i.assignee) : null,
  };
}

/** 提及候选：后端 `SearchItem` → 编辑器吃的 `MentionCandidate`（与 routes/topic.tsx 同一份映射：
 *  id 后端就是数字 user id，正是 `mention:<id>` 里那个真源；avatar 已拼成 /img/<hash>；
 *  ambiguous（按显示名判的重名）就是编辑器要的 duplicate 标记）。 */
export function toMentionCandidates(items: SearchUser[]): MentionCandidate[] {
  return items.map((u) => ({
    id: String(u.id),
    handle: u.handle,
    nickname: u.nickname,
    avatar: u.avatar,
    duplicate: u.ambiguous,
  }));
}

/** IssueCommentDTO → @/ui/comment 的 CommentData（与 routes/_parts/mappers.ts 的 toComments 同一套映射）。 */
export function toIssueComment(c: ApiIssueComment, replies: ApiIssueComment[]): CommentData {
  const one = (x: ApiIssueComment): CommentData => ({
    id: x.id,
    author: toIssueUser(x.author),
    body: x.body_html,
    createdAt: formatTime(x.created_at),
    likes: x.like_count,
    // J3（拍板）：踩数**按身份下发** —— 普通用户 / 游客的响应里没有这个键（DTO 带 omitempty），
    // 所以这里**故意不回落成 0**：`?? 0` 会把「接口没给」变成「0 个踩」，等于前端替后端把这个数补出来。
    // CommentData.dislikes 已是可选：undefined 传到 CommentActions 就是**那一格不显示数字**，
    // 「我自己点没点」由下面的 disliked（my_vote）回答。
    dislikes: x.dislike_count,
    // 真源是 my_vote（dto.go:198），不是 viewer.value —— 读错字段时赞踩态恒为假且不报错
    liked: x.my_vote === 1,
    disliked: x.my_vote === -1,
  });
  const base = one(c);
  return replies.length === 0 ? base : { ...base, replies: { total: replies.length, items: replies.map(one) } };
}

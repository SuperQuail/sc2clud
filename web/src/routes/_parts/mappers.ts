import type { Topic as ApiTopic, Post, TopicKind as ApiKind } from '@/lib/api/forum';
import type { CommentData } from '@/ui/comment/types';
import type { Topic } from '@/devroom/pages/14-home/mock';

// 接口形状 → 房子件的 props。**这一层存在的理由**：房子件（14-home 的卡片族、ui/comment）
// 吃的是它们自己的形状，而接口给的是 §21.3 的形状；两侧都不该为了对方改签名。
// 所以转换只在这一个文件里 —— 产品页与房间共用同一份组件实现（上线设计 P2 决策 2）。

/** §21.3 列表项 → 卡片族的 Topic。字段名一一对应，只有 excerpt / cover 要兜底。 */
export function toCardTopic(t: ApiTopic): Topic {
  return {
    id: t.id,
    board: t.board,
    kind: t.kind as ApiKind,
    title: t.title,
    // excerpt 是列表项缺的字段（已作后端需求变动挂账）：拿不到就空着，**不拉全文再截断**
    excerpt: t.excerpt ?? '',
    author: t.author,
    reply_count: t.reply_count,
    like_count: t.like_count,
    view_count: t.view_count,
    created_at: t.created_at,
    last_reply_at: t.last_reply_at ?? t.created_at,
    cover: t.cover ?? null,
    pinned: t.pinned,
    featured_at: t.featured_at,
  };
}

/** 回复（§21.2 的 posts）→ 评论区的 CommentData；楼中楼按 parent_id 归并（只允许一级，后端保证）。 */
export function toComments(posts: Post[]): CommentData[] {
  const toComment = (p: Post): CommentData => ({
    id: p.id,
    author: p.author,
    body: p.content_html,
    createdAt: p.created_at,
    likes: p.like_count,
    // dislike_count 是否随响应下发待 P1 确认（§21.2 只写了「点赞数」）；缺省 0 不会假装踩过
    dislikes: p.dislike_count ?? 0,
    liked: p.viewer?.value === 1,
    disliked: p.viewer?.value === -1,
  });
  const roots = posts.filter((p) => p.parent_id === null);
  const repliesOf = new Map<string, Post[]>();
  for (const p of posts) {
    if (p.parent_id === null) continue;
    const list = repliesOf.get(p.parent_id) ?? [];
    list.push(p);
    repliesOf.set(p.parent_id, list);
  }
  return roots.map((root) => {
    const children = repliesOf.get(root.id) ?? [];
    const c = toComment(root);
    if (children.length === 0) return c;
    return {
      ...c,
      replies: { total: children.length, previewCount: 2, items: children.map(toComment) },
    };
  });
}

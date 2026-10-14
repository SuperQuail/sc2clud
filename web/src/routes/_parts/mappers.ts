import { BASE } from '@/lib/base';
import type { Topic as ApiTopic, Post, TopicKind as ApiKind } from '@/lib/api/forum';
import type { CommentData } from '@/ui/comment/types';
import type { Topic } from '@/devroom/pages/14-home/mock';

// 接口形状 → 房子件的 props。**这一层存在的理由**：房子件（14-home 的卡片族、ui/comment）
// 吃的是它们自己的形状，而接口给的是后端 DTO 的形状；两侧都不该为了对方改签名。
// 所以转换只在这一个文件里 —— 产品页与房间共用同一份组件实现（上线设计 P2 决策 2）。

/** 后端给的是**图片 hash**，字节走 media 的读端点 `GET /img/<hash>`（forum/dto.go 的注释：前端按它拼）。 */
export function imageUrl(hash?: string | null): string | null {
  return hash ? BASE + 'img/' + hash : null;
}

/** 后端 DTO 的列表项 → 卡片族的 Topic（裸哈希在这一步换算成可直接用的 URL）。
 *  两边的字段名都是真的（ApiTopic 照 TopicCardDTO 抄），所以**没有局部类型、没有 `as`**（2026-10-14 收口）。 */
export function toCardTopic(t: ApiTopic): Topic {
  return {
    id: t.id,
    board: t.board,
    kind: t.kind as ApiKind,
    title: t.title,
    excerpt: t.excerpt,
    author: {
      ...t.author,
      avatar: imageUrl(t.author.avatar_hash),
    },
    reply_count: t.reply_count,
    like_count: t.like_count,
    view_count: t.view_count,
    created_at: t.created_at,
    last_reply_at: t.last_reply_at ?? t.created_at,
    cover: imageUrl(t.cover_hash),
    pinned: t.pinned,
    featured: t.featured,
  };
}

/** 回复（§21.2 的 posts）→ 评论区的 CommentData；楼中楼按 parent_id 归并（只允许一级，后端保证）。 */
export function toComments(posts: Post[]): CommentData[] {
  // 楼里的作者也是**裸哈希**（UserBriefDTO），不换算的话评论区的头像一个都不显示 ——
  // 与列表同一个坑，所以同一个换算：imageUrl(hash)。
  const toComment = (p: Post): CommentData => ({
    id: p.id,
    author: { ...p.author, avatar: imageUrl(p.author.avatar_hash) },
    body: p.content_html,
    createdAt: p.created_at,
    likes: p.like_count,
    // dislike_count 是否随响应下发待 P1 确认（§21.2 只写了「点赞数」）；缺省 0 不会假装踩过
    dislikes: p.dislike_count ?? 0,
    // 真源是 PostDTO.my_vote（forum/dto.go:131），不是 viewer.value —— 读错字段时赞踩态恒为假且不报错
    liked: p.my_vote === 1,
    disliked: p.my_vote === -1,
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

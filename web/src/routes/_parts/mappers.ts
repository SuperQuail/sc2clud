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

/**
 * 列表项里**按后端 DTO 命名**的那几个字段（forum/internal/forum/dto.go 的 TopicCardDTO / UserBriefDTO）。
 *
 * shortcut: `@/lib/api/forum` 的 Topic 类型还停在设计稿的名字上（cover / featured_at / author.avatar），
 * 而线上返回的是 cover_hash / featured / avatar_hash —— 2026-10-14 实测 /dev/api/v1/topics。
 * 那边是**别人的在途写作用域**，改完这里就删掉本类型与下面那行 `as`。
 */
type TopicCardRaw = {
  cover_hash?: string | null;
  author: { avatar_hash?: string | null; avatar_small_hash?: string | null };
  featured?: boolean;
};

/** 后端 DTO 的列表项 → 卡片族的 Topic（cover / avatar 在这一步换算成可直接用的 URL）。 */
export function toCardTopic(t: ApiTopic): Topic {
  const raw = t as ApiTopic & TopicCardRaw;
  return {
    id: t.id,
    board: t.board,
    kind: t.kind as ApiKind,
    title: t.title,
    // excerpt 是列表项缺的字段（已作后端需求变动挂账）：拿不到就空着，**不拉全文再截断**
    excerpt: t.excerpt ?? '',
    author: {
      ...t.author,
      avatar: imageUrl(raw.author.avatar_hash) ?? t.author.avatar ?? null,
    },
    reply_count: t.reply_count,
    like_count: t.like_count,
    view_count: t.view_count,
    created_at: t.created_at,
    last_reply_at: t.last_reply_at ?? t.created_at,
    cover: imageUrl(raw.cover_hash) ?? t.cover ?? null,
    pinned: t.pinned,
    featured: raw.featured === true,
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

import { BASE } from '@/lib/base';
import { formatMinute } from '@/lib/format';
import type { Board as ApiBoard, Topic as ApiTopic, Post, TopicKind as ApiKind } from '@/lib/api/forum';
import type { CommentData } from '@/ui/comment/types';
import type { Topic } from '@/devroom/pages/14-home/mock';
import type { BoardSummary } from '@/devroom/pages/03-navigation/board-rail';

// 接口形状 → 房子件的 props。**这一层存在的理由**：房子件（14-home 的卡片族、ui/comment）
// 吃的是它们自己的形状，而接口给的是后端 DTO 的形状；两侧都不该为了对方改签名。
// 所以转换只在这一个文件里 —— 产品页与房间共用同一份组件实现（上线设计 P2 决策 2）。

/** 后端给的是**图片 hash**，字节走 media 的读端点 `GET /img/<hash>`（forum/dto.go 的注释：前端按它拼）。 */
export function imageUrl(hash?: string | null): string | null {
  return hash ? BASE + 'img/' + hash : null;
}

/**
 * 后端 BoardDTO[] → 分区侧栏 View 吃的 BoardSummary[]。**全站唯一一处**做这个形状对齐的地方
 * （首页 / 分区页 / 帖子页左栏共用；首页与分区页经 _parts/layout 的 BoardRail 宿主，帖子页直接调它）。
 *
 * 字段名照 dto.go:43 的 **cover_hash**（裸哈希，不是路径）；lib/api/forum.ts 的 Board 还停在上一次
 * 收口的 `cover`（I5 那类欠账的另一处），所以两个形状都接着 —— 线上走的是 cover_hash 那半边。
 * D21：帖子页左栏过去读的正是那个不存在的 `cover`，于是恒为空、恒灰块。
 */
export function boardRows(boards: ApiBoard[]): BoardSummary[] {
  return boards.map((b) => {
    const raw = b as { cover?: string | null; cover_hash?: string };
    return {
      slug: b.slug,
      name: b.name,
      description: b.description,
      topic_count: b.topic_count,
      // 今日 N（用户 2026-10-15 拍板「可以加」）：左栏那一格用它，字段本来就是 BoardDTO 的 today_count。
      today_count: b.today_count,
      cover_hash: raw.cover_hash ?? raw.cover ?? '',
    };
  });
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
    // J9：后端在列表项里就给了封面原图尺寸 —— 卡片因此能在**发出图片请求之前**判「这张放大出来会糊」，
    // 而不是先把小图拉下来再回退（原先只有后一条路，靠 onload 量 naturalWidth）。
    cover_width: t.cover_width,
    cover_height: t.cover_height,
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
    // D74：评论动作行渲染过整个 RFC3339 —— 换算只在这层做，落到分钟精度
    createdAt: formatMinute(p.created_at),
    likes: p.like_count,
    // J3（拍板）：踩数**按身份下发** —— 后端给普通用户 / 游客的响应里根本没有 `dislike_count` 这个键
    // （DTO 上带 omitempty）。所以这里**不能回落成 0**：`?? 0` 会把「接口没下发」渲染成「0 个踩」，
    // 等于前端把这根信任边界又补回来了。CommentData.dislikes 已是可选，undefined 一路传到
    // CommentActions 就是「那一格不显示数字」，而「我自己点没点」由下面的 disliked 回答。
    dislikes: p.dislike_count,
    // 真源是 PostDTO.my_vote（forum/dto.go:131），不是 viewer.value —— 读错字段时赞踩态恒为假且不报错
    liked: p.my_vote === 1,
    disliked: p.my_vote === -1,
  });
  // D71 双保险：后端会把 GET /topics/{id}/posts 的 1 楼（主楼正文）撤出列表，但部署时序差里老响应还带着它 ——
  // 楼层号只用来把主楼挡在评论区外，正文区已经画过一次了；没带 floor 的老 fixture 照旧通过。
  const roots = posts.filter((p) => p.parent_id === null && p.floor !== 1);
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

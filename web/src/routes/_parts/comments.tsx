import { CommentList } from '@/ui/comment/comment-list';
import type { CommentData } from '@/ui/comment/types';

// 评论区的**按需加载壳**：CommentList 内部会引 ReplyBox → MarkdownEditor → Lexical（约 90KB gzip）。
// 它是「帖子页唯一需要富文本的地方」，而且评论本身要等 GET /topics/{id}/posts 才有内容 ——
// 所以把它拆出去，帖子正文与标题能立刻出现，编辑器随后到（不是白屏，是一个明确的加载态）。
// 壳的存在只是为了给 lazy 一个默认导出：src/ui 是控件库，不该为了路由分割改造它的导出形状。
export default function Comments(props: {
  comments: CommentData[];
  total: number;
  me: { nickname: string; avatar?: string | null };
  onSubmit?: (parentId: string | null, body: { json: string; html: string }) => void;
  onVote?: (id: string, value: 1 | -1) => void;
}) {
  return <CommentList {...props} />;
}

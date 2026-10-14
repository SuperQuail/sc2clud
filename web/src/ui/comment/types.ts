import type { UserSummary } from '@/ui/user/user-badge';

// 评论区的数据形状（与后端契约一致：作者用统一的 UserSummary）。
export type CommentReplies = {
  total: number;
  items: CommentData[];
  /** 楼中楼默认只显示前几条 */
  previewCount?: number;
};

export type CommentData = {
  id: string;
  author: UserSummary;
  /** 正文（纯文本或已渲染的 Markdown 片段） */
  body: string;
  createdAt: string;
  likes: number;
  /** J3（拍板）：踩数**按身份下发** —— 普通用户 / 游客拿到的是 undefined（后端 DTO 带 omitempty，
   *  只有管理员以上与内容作者拿得到这个数）。undefined 是「这一格不显示数字」，**不是 0 个踩**。 */
  dislikes?: number;
  liked?: boolean;
  disliked?: boolean;
  /** 作者与当前用户互相关注 */
  mutual?: boolean;
  /** 楼主/作者本人标记（帖子作者在评论区说话） */
  op?: boolean;
  replies?: CommentReplies;
};

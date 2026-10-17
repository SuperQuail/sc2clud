import type { ChatMessage } from '@/ui/message/notice-chat';
import type { UserSummary } from '@/ui/user/user-badge';

// 私信（一对一）的领域形状。**页面内 mock**：本页是设计验证页，不 fetch、不接 api client。
// 字段名照后端契约 §21.2「私信 message」段：
//   GET /api/v1/messages           → 会话列表：对方 + 最后一条 + 未读
//   GET /api/v1/messages/{handle}  → 与某人的消息（游标分页）
//   POST /api/v1/messages/{handle} → { body } → 201；被拉黑返回 403
// 所以「对方」用 handle 定位会话（URL 也是 ?peer=<handle>），与契约同源。
export type Peer = UserSummary;

export type Conversation = {
  /** 会话主键 = 对方的 handle（契约里私信按 handle 定位） */
  peer: Peer;
  /** 消息（时间序，最后一条就是列表里的摘要来源） */
  messages: ChatMessage[];
  /** 最后一条消息的纯文本摘要（列表用；从 html 里剥出来） */
  summary: string;
  /** 展示用时间串（「今天 11:02」） */
  lastAt: string;
  /** 未读数（0 不显示角标） */
  unread: number;
};

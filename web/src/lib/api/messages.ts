import { api, apiEnvelope, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';
import type { Paged } from './forum';

// 私信（v2 §21.2 的 message 段）。契约形状照抄后端 message/types.go，不照设计稿猜。
//
// 2026-10-13：这些端点在**后端一直都在**（message.Handler.Register 挂了 6 条），
// 前端连函数都没有，所以 /messages 是个占位页。

export type MessagePeer = {
  handle: string;
  nickname: string;
  avatar?: string | null;
  avatar_small?: string | null;
};

/** mine = 我发的；read = **收件人**已读（我发的那条由对方读）—— 后端 types.go 的原话。 */
export type Message = {
  id: string;
  body: string;
  mine: boolean;
  read: boolean;
  created_at: string;
};

export type Conversation = {
  peer: MessagePeer;
  unread_count: number;
  last: Message;
};

/** 会话页的包络比列表多一个 peer（d4 §5.2）：没有会话列表时也要能渲染会话头。 */
export type MessageThread = { items: Message[]; next: string | null; peer: MessagePeer };

export function fetchConversations(q: PageQuery = {}, signal?: AbortSignal): Promise<Paged<Conversation>> {
  return apiPage<Conversation>('messages', { query: pageQuery(q), signal });
}

export function fetchUnreadMessages(signal?: AbortSignal): Promise<{ count: number }> {
  return api<{ count: number }>('messages/unread-count', { signal });
}

export async function fetchThread(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<MessageThread> {
  const p = await apiEnvelope<{ data?: Message[]; next_cursor?: string | null; peer: MessagePeer }>(
    'messages/' + encodeURIComponent(handle),
    { query: pageQuery(q), signal },
  );
  return { items: p.data ?? [], next: p.next_cursor ?? null, peer: p.peer };
}

/** 正文是**纯文本**（后端 body 是 varchar，没有 content_html）：界面上按文本渲染，不当 HTML 用。 */
export function sendMessage(handle: string, body: string): Promise<Message> {
  return api<Message>('messages/' + encodeURIComponent(handle), { method: 'POST', body: { body } });
}

export function markThreadRead(handle: string): Promise<{ updated: number }> {
  return api<{ updated: number }>('messages/' + encodeURIComponent(handle) + '/read', { method: 'POST' });
}

export function deleteMessage(id: string): Promise<null> {
  return api<null>('messages/' + encodeURIComponent(id), { method: 'DELETE' });
}

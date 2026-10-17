import type { ReactNode } from 'react';
import { PageHeader } from '@/routes/_parts/layout';
import { noticeHead, type Panel } from './notice-logic';

// 信息中心的页头 —— **两个入口共用**：真站（routes/messages.tsx）与 DevRoom 10-messages 都渲染它，
// 只是喂的未读数不同（房间是假数据）。文案在 notice-logic 的 noticeHead 里，这里只管排版。
//
// 为什么它必须共用：清单 §0 的判据是「两个地方看同一个页面完全一样」，而页头是页面最上面那一块 ——
// 各写一份的话，标题与未读口径会先在这里分叉。
export function NoticeHead({
  panel,
  data,
  action,
}: {
  panel: Panel;
  /** 未读数（房间给假数据、真站给 qk.unread 或 qk.unreadMessages）；null = 还没拿到 */
  data?: { unreadMessages?: number | null; unreadNotices?: number | null; live?: boolean };
  /** 右侧动作（真站是「全部已读」）。房间没有写动作，所以不传 —— 空着而不是给一颗假的 */
  action?: ReactNode;
}) {
  const head = noticeHead(panel, data);
  return <PageHeader title={head.title} description={head.description} actions={action} />;
}

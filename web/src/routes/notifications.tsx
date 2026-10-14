// 路由 \`/notifications\` 的入口。
//
// 2026-10-14：信息中心重建后，\`/messages\` 与 \`/notifications\` **渲染的是同一个 NoticeCenter**
// （只在默认档上不同：「我的消息」vs「回复我的」），所以这一页不再自己写一份通知列表 ——
// 原先这里是一个手写 \`<ul>/<li>\` 的列表，而 DevRoom 的 \`NoticeList\`/\`NoticeRow\` 一直没人用：
// 两份实现必然在未读角标与动作按钮上分叉。
//
// 真身与四档的取数都在 \`routes/messages.tsx\`（\`NotificationsPage\`）。
export { NotificationsPage } from './messages';

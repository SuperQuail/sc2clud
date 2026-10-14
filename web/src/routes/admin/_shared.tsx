import type { ComponentType } from 'react';
import { Empty } from '@/routes/_parts/state';
import { isApiError } from '@/lib/api/errors';

// admin 容器的**共享件**：一屏一个容器（见 ./index 的说明），而这个文件只放两样东西 ——
// 「把失败翻成一句人话」与「端点还没到时的占位屏」。
// 拆出来的理由只有一个：gate:size（单文件 ≤ 500 行），10 个容器放一个文件已经 690 行。

/** 容器把任何失败翻成一句人话（不吞错误，也不把 500 说成「没有数据」）。
 *  **不带状态码**：屏上的模板已经在写「（HTTP 404）」，带上就成了「HTTP 404 HTTP 404 接口不存在」。 */
export function errorLine(e: unknown): string | null {
  if (!e) return null;
  if (isApiError(e)) return e.message + (e.requestId ? '（编号 ' + e.requestId + '）' : '');
  return String(e);
}

/** 后端还没有这些路由的屏（谁缺哪一条写在表里，**不拿示例数据兜底**）。 */
const PENDING_SCREENS: Record<string, { perm: string; what: string; endpoints: string[] }> = {
  boards: { perm: 'board.manage', what: '分区管理', endpoints: ['GET /admin/boards', 'PUT /admin/boards/{id}/acl', 'POST /admin/boards/reorder'] },
  diagnostics: { perm: 'site.setting', what: '自检面板', endpoints: ['GET /admin/diagnostics'] },
};

/** 造一个「这一屏的端点还没到」的占位屏。工厂而不是组件：admin.tsx 的映射表要的是组件类型。 */
export function PendingScreen(key: string): ComponentType<Record<string, never>> {
  const p = PENDING_SCREENS[key];
  if (!p) throw new Error('PendingScreen: 没有登记 ' + key);
  const C = () => (
    <Empty
      title={p.what + '还没有可以对接的端点'}
      hint={
        '这一屏已经改成 prop 驱动、权限点也按真实 perms 判（' + p.perm + '），但后端还缺：' +
        p.endpoints.join('、') + '。在这一条落地前它不会拿示例数据兜底 —— ' +
        '「界面看着正常、其实什么都没发生」正是本仓库要消灭的形态。'
      }
    />
  );
  C.displayName = 'PendingScreen_' + key;
  return C;
}

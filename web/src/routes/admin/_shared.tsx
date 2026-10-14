import { isApiError } from '@/lib/api/errors';

// admin 容器的**共享件**：一屏一个容器（见 ./index 的说明），这个文件只放一样东西 ——
// 「把失败翻成一句人话」。拆出来的理由只有一个：gate:size（单文件 ≤ 500 行），10 个容器放一个文件已经 690 行。
//
// 这里原来还有一个 PendingScreen（端点没到时渲染「这一屏还没有可以对接的端点」）。C1/C2/C3 落地、
// 12 屏全接完之后它没有使用者了，所以删掉：**留着一个没人用的占位屏，下一个人就会以为还有哪一屏没接。**

/** 容器把任何失败翻成一句人话（不吞错误，也不把 500 说成「没有数据」）。
 *  **不带状态码**：屏上的模板已经在写「（HTTP 404）」，带上就成了「HTTP 404 HTTP 404 接口不存在」。 */
export function errorLine(e: unknown): string | null {
  if (!e) return null;
  if (isApiError(e)) return e.message + (e.requestId ? '（编号 ' + e.requestId + '）' : '');
  return String(e);
}


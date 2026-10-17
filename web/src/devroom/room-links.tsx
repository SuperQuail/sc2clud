import type { ReactNode } from 'react';
import { appPath } from '@/lib/url';
import { cn } from '@/lib/utils';

// 房间里的站内跳转**只能用 roomHref()**。
// 为什么：房间挂在旧站域名下（/dev/devroom/），appPath('/xxx') 生成的是**旧站**路径 ——
// 点下去会落到旧站的 404，而且从那个 404 回不到房间（盲审一号 2026-10-13 报的问题 2：
// 首页「浏览分区 / 发布战役 / 开始使用」、页脚「关于 / 版规 / 联系」、帖子页「发帖」全都这样）。
//
// 两条出路（二选一，不许别出心裁）：
//   ① 房间里有对应页面 → roomHref('14-home')；
//   ② 房间还没有 → ProtoLink / protoTitle 显式标「未做」，**不可导航**（不是链接、不带 href）。
export function roomHref(pageKey: string): string {
  return appPath('?page=' + pageKey);
}

/** 统一的「设计稿 · 未做」标题文案：所有不可导航的地方都用它，避免每页各写一句。 */
export function protoTitle(what: string): string {
  return '设计稿：' + what + ' 还没接，房间里点它不跳转';
}

/** 房间还没有的页面/接口：不可导航，并显式标出「未做」。 */
export function ProtoLink({ children, what, className }: { children: ReactNode; what: string; className?: string }) {
  return (
    <span aria-disabled='true' title={protoTitle(what)} className={cn('cursor-not-allowed text-muted-foreground', className)}>
      {children}
      <span className='ml-1 rounded-sm bg-muted px-1 text-[10px]'>未做</span>
    </span>
  );
}

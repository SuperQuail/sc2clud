import { appPath } from '@/lib/url';

// 临时的「开发页面」入口。**只在构建期开了 VITE_DEVROOM 时出现**，生产构建没有。
// 路径交给 src/lib/url.ts 统一构造，这里不写死前缀（写死过一次，dev 下跳去了生产端）。
const enabled = Boolean(import.meta.env.VITE_DEVROOM);

export function DevEntry() {
  if (!enabled) return null;
  return (
    // max-sm 收紧并上移：390 视口下原来的 144×40 胶囊正好压在页脚「SC2clud · 星际争霸战役社区」上
    // （2026-10-14 出图实测，footer 高 73px、胶囊落在它中间）。浮层不给页面留位，只能让自己别盖住东西。
    <a
      href={appPath('devroom/')}
      data-testid='devroom-entry'
      className='fixed bottom-4 right-4 z-50 inline-flex items-center rounded-full bg-foreground px-4 py-2.5 text-sm font-semibold text-background shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:bottom-20 max-sm:right-3 max-sm:px-3 max-sm:py-2 max-sm:text-xs'
    >
      开发页面（临时）
    </a>
  );
}

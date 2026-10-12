import { appPath } from '@/lib/url';

// 临时的「开发页面」入口。**只在构建期开了 VITE_DEVROOM 时出现**，生产构建没有。
// 路径交给 src/lib/url.ts 统一构造，这里不写死前缀（写死过一次，dev 下跳去了生产端）。
const enabled = Boolean(import.meta.env.VITE_DEVROOM);

export function DevEntry() {
  if (!enabled) return null;
  return (
    <a
      href={appPath('devroom/')}
      className='fixed bottom-4 right-4 z-50 inline-flex items-center rounded-full bg-foreground px-4 py-2.5 text-sm font-semibold text-background shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
    >
      开发页面（临时）
    </a>
  );
}

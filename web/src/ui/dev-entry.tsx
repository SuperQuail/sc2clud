// 临时的「开发页面」入口。**只在构建期给了 VITE_DEVROOM 时出现**，生产构建不传就没有。
// 为什么是组件而不是让 Go 注入 HTML：注入的字符串在门禁之外（gate:ui 只扫 src/**/*.tsx），
// 也拿不到令牌——那等于在规范之外又开一套写法。
const href = (import.meta.env.VITE_DEVROOM as string | undefined) ?? '';

export function DevEntry() {
  if (!href) return null;
  return (
    <a
      href={href}
      className='fixed bottom-4 right-4 z-50 inline-flex items-center rounded-full bg-foreground px-4 py-2.5 text-sm font-semibold text-background shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
    >
      开发页面（临时）
    </a>
  );
}

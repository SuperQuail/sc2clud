import type { ComponentType, SVGAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

// Ring UI 的 icon prop 期望「固有尺寸正确」的 SVG 组件，而 lucide 默认 24×24——
// 直接把 lucide 传进去会撑破控件的内容高度，表现为图标与文字错位（已验证的坑）。
// 所以：**凡是把图标交给 Ring UI 控件，一律先用 icon16() 包一层**。
export type RingIcon = ComponentType<SVGAttributes<SVGSVGElement>>;

export function icon16(Icon: LucideIcon): RingIcon {
  function Wrapped(props: SVGAttributes<SVGSVGElement>) {
    return <Icon {...props} size={16} />;
  }
  Wrapped.displayName = 'Icon16(' + (Icon.displayName ?? Icon.name ?? 'Icon') + ')';
  return Wrapped;
}

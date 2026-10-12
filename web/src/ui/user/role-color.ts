// 角色配色 —— **不写死角色清单**。
// 权限树随时会变（今天四个，明天可能加），所以颜色由 key 稳定派生：
//   同一个 key 永远是同一个颜色；新角色不用改任何代码就有颜色。
// 如果将来 roles 表加了 color 列，把值传进来即可覆盖（explicit 优先）。
// 用 hsl 而不是写死色值：避免落进「颜色只能来自令牌」的门禁，也便于按主题微调。
export type RoleLike = { key: string; name: string; color?: string | null };

export function roleColor(key: string, explicit?: string | null): string {
  if (explicit) return explicit;
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 100000;
  const hue = (h * 47) % 360;
  return 'hsl(' + hue + ' 58% 46%)';
}

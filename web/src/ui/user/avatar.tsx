import { cn } from '@/lib/utils';
import { imagePath } from '@/lib/url';

// 用户头像（设计语言 B：用户向）。**不用 Ring UI 的 Avatar**：那是给开发者看的控件，
// 尺寸白名单死、alt 写死英文；头像是普通用户天天看的东西，必须我们自己控。
const SIZE = { sm: 24, md: 32, lg: 40, xl: 56 } as const;
export type UserAvatarSize = keyof typeof SIZE;

// 无头像时按昵称取一个稳定的色相（同一个人每次都是同色）
const HUES = [212, 262, 330, 12, 152, 190];
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 100000;
  return HUES[h % HUES.length]!;
}

export type UserAvatarProps = {
  name: string;
  src?: string | null;
  size?: UserAvatarSize;
  /** 旁边已经写了名字时留空（装饰性）；单独出现时传名字 */
  alt?: string;
  className?: string;
};

export function UserAvatar({ name, src, size = 'md', alt = '', className }: UserAvatarProps) {
  const px = SIZE[size];
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white select-none', className)}
      style={{
        width: px,
        height: px,
        fontSize: Math.round(px * 0.42),
        background: src ? 'var(--muted)' : 'hsl(' + hueOf(name) + ' 62% 46%)',
      }}
    >
      {src ? (
        // 后端给的 '/img/<hash>' 是站根路径，必须过 imagePath 才落在本实例前缀下（否则 /dev 下是坏图）
        <img src={imagePath(src)} alt={alt ?? name} width={px} height={px} loading='lazy' decoding='async' className='size-full object-cover' />
      ) : (
        <span aria-hidden>{[...name][0] ?? '?'}</span>
      )}
    </span>
  );
}

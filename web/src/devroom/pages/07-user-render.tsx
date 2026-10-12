import { Shield, Sparkles } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import type { UserSummary } from '@/ui/user/user-badge';

// DevRoom 07 · 用户渲染三版候选（先定这个，再谈帖子页）
// 同一批人的三处场景（列表行 / 楼层 / 作者卡），三套排布。挑一套作为全站基线。
const A = (p: string) => assetUrl(p);

const ME: UserSummary = {
  handle: 'tangtian',
  nickname: '唐天',
  avatar: A('miyin-portrait-320.webp'),
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
const MOD: UserSummary = { handle: 'linshi', nickname: '林诗', avatar: A('miyin-chibi-160.webp'), role: { key: 'moderator', name: '版主' } };
const PLAIN: UserSummary = { handle: 'newbie', nickname: '新来的', role: { key: 'member', name: '会员' }, title: { name: '新手上路', color: '#059669' } };
const ROWS = [ME, MOD, PLAIN];

function Frame({ n, name, tagline, children }: { n: string; name: string; tagline: string; children: React.ReactNode }) {
  return (
    <section className='overflow-hidden rounded-xl border border-border'>
      <header className='flex flex-wrap items-baseline gap-3 bg-muted px-4 py-2.5'>
        <h2 className='text-[13px] font-semibold text-foreground'>第 {n} 版 · {name}</h2>
        <p className='text-[12px] text-muted-foreground'>{tagline}</p>
      </header>
      <div className='flex flex-col gap-3 bg-background p-4'>{children}</div>
    </section>
  );
}

function Ctx({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-2 rounded-lg border border-border p-3'>
      <span className='text-[11px] text-muted-foreground'>{label}</span>
      {children}
    </div>
  );
}

const TITLE = '《星海余烬》第三章发布：18 张地图，三个结局';

export default function UserRenderPage() {
  return (
    <div className='flex flex-col gap-5'>
      <Frame n='1' name='徽标紧跟名字（行内）' tagline='最省纵向空间；名字长时徽标会被挤到换行'>
        {ROWS.map((u) => (
          <Ctx key={u.handle} label='列表行'>
            <span className='text-[15px] font-medium text-foreground'>{TITLE}</span>
            <span className='flex items-center gap-2'>
              <UserAvatar name={u.nickname} src={u.avatar} size='sm' />
              <span className='text-sm font-medium text-foreground'>{u.nickname}</span>
              {u.role ? <RoleBadge role={u.role} /> : null}
              {u.title ? <TitleBadge title={u.title} /> : null}
              <span className='text-xs text-muted-foreground'>2 小时前</span>
            </span>
          </Ctx>
        ))}
      </Frame>

      <Frame n='2' name='名字一行、徽标一行' tagline='名字再长也不挤徽标；多占一行高度'>
        {ROWS.map((u) => (
          <Ctx key={u.handle} label='列表行'>
            <span className='text-[15px] font-medium text-foreground'>{TITLE}</span>
            <span className='flex items-start gap-2'>
              <UserAvatar name={u.nickname} src={u.avatar} size='sm' />
              <span className='flex min-w-0 flex-col gap-1'>
                <span className='flex items-center gap-2'>
                  <span className='truncate text-sm font-medium text-foreground'>{u.nickname}</span>
                  <span className='shrink-0 text-xs text-muted-foreground'>2 小时前</span>
                </span>
                <span className='flex flex-wrap items-center gap-1.5'>
                  {u.role ? <RoleBadge role={u.role} /> : null}
                  {u.title ? <TitleBadge title={u.title} /> : null}
                </span>
              </span>
            </span>
          </Ctx>
        ))}
      </Frame>

      <Frame n='3' name='头衔前缀 + 角色着色' tagline='不额外占位：头衔写在名字前，权限靠名字颜色与图标表达'>
        {ROWS.map((u) => {
          const tone = u.role?.key === 'admin' ? 'text-destructive' : u.role?.key === 'moderator' ? 'text-primary' : 'text-foreground';
          return (
            <Ctx key={u.handle} label='列表行'>
              <span className='text-[15px] font-medium text-foreground'>{TITLE}</span>
              <span className='flex items-center gap-2'>
                <UserAvatar name={u.nickname} src={u.avatar} size='sm' />
                <span className='flex min-w-0 items-center gap-1.5'>
                  {u.title ? (
                    <span
                      className='shrink-0 text-[11px] font-semibold'
                      style={{ color: u.title.color ?? 'var(--primary)' }}
                    >
                      {u.title.name}
                    </span>
                  ) : null}
                  {u.title ? <span aria-hidden className='text-muted-foreground'>·</span> : null}
                  <span className={'truncate text-sm font-semibold ' + tone}>{u.nickname}</span>
                  {u.role?.key === 'admin' ? <Shield aria-hidden className='size-3.5 shrink-0 text-destructive' /> : null}
                  {u.title ? <Sparkles aria-hidden className='size-3.5 shrink-0 text-muted-foreground' /> : null}
                  <span className='shrink-0 text-xs text-muted-foreground'>2 小时前</span>
                </span>
              </span>
            </Ctx>
          );
        })}
      </Frame>

      <section className='rounded-lg border border-dashed border-border p-3'>
        <h2 className='text-sm font-semibold text-foreground'>三版都用同一批数据</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          管理员（红）+ 执政官（蓝）／版主（蓝）无头衔／普通会员（绿）+ 新手上路。选定后写进 src/ui/user，全站统一。
        </p>
      </section>
    </div>
  );
}

import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { assetUrl } from '@/lib/url';
import { DropdownPanel } from '@/ui/dropdown-panel';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge, type RoleDesign } from '@/ui/user/role-badge';
import { TitleBadge, type TitleDesign } from '@/ui/user/title-badge';
import { Username, type UsernameBadge } from '@/ui/user/username';

// DevRoom 07 · 用户身份与权限
// 权限模型见 完全重构/RBAC权限树设计.md：基线单角色 ∪ 点对点追加（带期限与理由）。
// 本页两件事：① 点击徽标本身展开「权限明细 / 头衔说明」；② 权限与头衔的**差异化方案三选一**。
const A = (p: string) => assetUrl(p);

const ADMIN = { key: 'admin', name: '管理员', color: '#2563eb' };
const CREATOR = { key: 'creator', name: '认证创作者', color: '#7c3aed' };
const USER = { key: 'user', name: '普通用户' };

const EXTRA = [
  { key: 'topic.pin', name: '置顶帖子', expires: null as string | null },
  { key: 'donation.review', name: '核验打赏', expires: '2026-11-15' as string | null },
];
const BOARDS = [{ board: '自制战役', expires: null as string | null }];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-2 border-b border-border py-3 last:border-0'>
      <span className='flex flex-wrap items-baseline gap-2'>
        <span className='text-[12px] font-medium text-foreground'>{label}</span>
        {hint ? <span className='text-[11px] text-muted-foreground'>{hint}</span> : null}
      </span>
      <span className='flex flex-wrap items-center gap-x-6 gap-y-3'>{children}</span>
    </div>
  );
}

function Card({ name, note, children }: { name: string; note: string; children: React.ReactNode }) {
  return (
    <section className='rounded-lg border border-border bg-card p-3'>
      <h2 className='text-sm font-semibold text-foreground'>{name}</h2>
      <p className='mb-1 text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      {children}
    </section>
  );
}

function RolePanelBody() {
  return (
    <>
      <span className='flex flex-col gap-1'>
        <span className='text-[11px] font-semibold text-muted-foreground'>基线角色</span>
        <span className='flex items-center gap-2'><RoleBadge role={ADMIN} /><span className='text-muted-foreground'>含其下全部继承权限</span></span>
      </span>
      <span className='flex flex-col gap-1'>
        <span className='text-[11px] font-semibold text-muted-foreground'>单独追加的权限（{EXTRA.length}）</span>
        {EXTRA.map((e) => (
          <span key={e.key} className='flex items-center justify-between gap-3'>
            <span className='text-foreground'>{e.name}</span>
            <span className='text-muted-foreground tabular-nums'>{e.expires ? e.expires + ' 到期' : '长期'}</span>
          </span>
        ))}
      </span>
      <span className='flex flex-col gap-1'>
        <span className='text-[11px] font-semibold text-muted-foreground'>分区授权（{BOARDS.length}）</span>
        {BOARDS.map((b) => (
          <span key={b.board} className='flex items-center justify-between gap-3'>
            <span className='text-foreground'>{b.board}</span>
            <span className='text-muted-foreground'>{b.expires ? b.expires + ' 到期' : '长期'}</span>
          </span>
        ))}
      </span>
    </>
  );
}

function TitlePanelBody() {
  return (
    <>
      <span className='flex flex-col gap-1'>
        <span className='text-[11px] font-semibold text-muted-foreground'>执政官</span>
        <span className='text-muted-foreground'>运营在 titles 表里配置的称号，与权限无关；一个用户只佩戴一个。</span>
        <span className='text-muted-foreground'>key：consul　颜色：#2563eb</span>
      </span>
    </>
  );
}

const PAIRS: Array<{ n: number; name: string; note: string; role: RoleDesign; title: TitleDesign }> = [
  {
    n: 1,
    name: 'Ring UI Tag 预设',
    note: '权限=Ring UI Tag（tagType 预设 + 半透明 backgroundColor）／头衔=半透明底 + 同色细描边',
    role: 1,
    title: 1,
  },
  {
    n: 2,
    name: 'Tailwind alpha · 形状对立',
    note: '两者都用 Tailwind 透明度修饰符（bg-*/12 直接生成半透明底）／权限方角小标签、头衔全圆胶囊',
    role: 2,
    title: 2,
  },
  {
    n: 3,
    name: '半透明底 + 色条',
    note: '两者都是半透明底，靠色条方向区分：权限左侧竖条、头衔底部横条',
    role: 3,
    title: 3,
  },
];

export default function UserControlsPage() {
  const [badge, setBadge] = useState<UsernameBadge>('corner');
  const MODES: UsernameBadge[] = ['none', 'corner', 'inline'];
  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='权限挂在用户名上 · 三种挂法（角标 / 行内 / 只显示名字）'
        note='权限不再是外面拼的一块，而是 Username 的部件；badge 开关决定挂法。点按钮实时切换。'
      >
        <Row label='开关' hint='none=只要名字；corner=角标；inline=跟在名字后'>
          <span className='flex items-center gap-2'>
            {MODES.map((m) => (
              <Button key={m} active={badge === m} onClick={() => setBadge(m)}>{m}</Button>
            ))}
          </span>
        </Row>
        <Row label='列表行（密集）' hint='角标在密集处最省地方'>
          <span className='flex items-center gap-2'><UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='示范管理员' role={ADMIN} badge={badge} /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
          <span className='flex items-center gap-2'><UserAvatar name='雷神' src={A('miyin-chibi-160.webp')} size='sm' /><Username nickname='雷神' role={CREATOR} badge={badge} /></span>
          <span className='flex items-center gap-2'><UserAvatar name='工蜂' size='sm' /><Username nickname='工蜂' role={USER} badge={badge} /></span>
        </Row>
        <Row label='作者位（加粗）与超长昵称'>
          <Username nickname='示范管理员' role={ADMIN} badge={badge} strong />
          <Username nickname='一个特别特别长的昵称用来压测截断行为' role={ADMIN} badge={badge} className='max-w-56' />
        </Row>
      </Card>

      <Card
        name='权限 × 头衔 · 差异化方案（三选一）'
        note='统一都用带颜色的半透明背景（Ring UI Tag 的 backgroundColor / Tailwind 的 bg-*/12），差异只靠形状、边框与色条方向。每套成对给出，点徽标可展开。'
      >
        {PAIRS.map((p) => (
          <Row key={p.n} label={'方案 ' + p.n + ' · ' + p.name} hint={p.note}>
            <span className='flex items-center gap-3'>
              <UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='sm' />
              <Username nickname='示范管理员' strong />
              <DropdownPanel label='权限明细' width='w-72' trigger={<RoleBadge role={ADMIN} design={p.role} />}>
                <RolePanelBody />
              </DropdownPanel>
              <DropdownPanel label='头衔说明' width='w-72' trigger={<TitleBadge title={{ name: '执政官', color: '#2563eb' }} design={p.title} />}>
                <TitlePanelBody />
              </DropdownPanel>
            </span>
            <span className='flex items-center gap-3'>
              <Username nickname='雷神' />
              <RoleBadge role={CREATOR} design={p.role} />
              <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} design={p.title} />
            </span>
            <span className='flex items-center gap-3'>
              <Username nickname='工蜂' />
              <RoleBadge role={USER} design={p.role} />
            </span>
          </Row>
        ))}
      </Card>

      <Card name='权限明细（点击徽标展开）' note='基线单角色 + 点对点追加（含到期）+ 分区授权。没有追加的人不显示可点状态。'>
        <Row label='有追加：可点' hint='点「管理员」看明细'>
          <span className='flex items-center gap-2'><UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='示范管理员' /><DropdownPanel label='权限明细' trigger={<RoleBadge role={ADMIN} />}><RolePanelBody /></DropdownPanel></span>
        </Row>
        <Row label='无追加：不可点' hint='只有基线角色，没有可展开的内容'>
          <span className='flex items-center gap-2'><UserAvatar name='工蜂' size='sm' /><Username nickname='工蜂' /><RoleBadge role={USER} /></span>
        </Row>
      </Card>

      <Card name='Username（用户名）' note='只渲染名字；默认前景色，可选自定义色；未激活只做暗色。'>
        <Row label='常规 / 加粗 / 自定义色 / 未激活'>
          <Username nickname='矿骡' />
          <Username nickname='示范管理员' strong />
          <Username nickname='示范管理员' color='#2563eb' />
          <Username nickname='蟑螂' state='inactive' />
        </Row>
        <Row label='尺寸 / @handle / 超长昵称'>
          <Username nickname='示范管理员' size='sm' />
          <Username nickname='示范管理员' size='lg' />
          <Username nickname='示范管理员' handle='demo-admin' />
          <span className='flex min-w-0 max-w-56'><Username nickname='一个特别特别长的昵称用来压测截断行为' /></span>
        </Row>
      </Card>

      <Card name='UserAvatar（头像）' note='四档尺寸；有图用图，无图按昵称取稳定色。'>
        <Row label='尺寸 / 真图 / 兜底'>
          <UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='sm' />
          <UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='md' />
          <UserAvatar name='雷神' src={A('miyin-chibi-160.webp')} size='lg' />
          <UserAvatar name='工蜂' size='xl' />
        </Row>
      </Card>

      <Card name='复用：三种场景' note='全是上面几个控件拼的；顺序与排布由使用方决定。'>
        <Row label='① 列表行'>
          <span className='flex items-center gap-2'><UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='示范管理员' /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
        </Row>
        <Row label='② 个人主页头部'>
          <span className='flex items-center gap-3'>
            <UserAvatar name='示范管理员' src={A('miyin-portrait-320.webp')} size='xl' />
            <span className='flex flex-col items-start gap-1'>
              <Username nickname='示范管理员' handle='demo-admin' size='lg' />
              <span className='flex items-center gap-1.5'><RoleBadge role={ADMIN} /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span>
            </span>
          </span>
        </Row>
        <Row label='③ 管理表格'>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='雷神' /><RoleBadge role={CREATOR} /></span>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='蟑螂' state='inactive' /><RoleBadge role={USER} /></span>
        </Row>
      </Card>
    </div>
  );
}

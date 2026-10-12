import { ChevronDown } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';

// DevRoom 07 · 用户身份与权限
// 按最终设计（见 完全重构/RBAC权限树设计.md）：
//   权限 = **基线单角色**（users.role_id）∪ **点对点追加**（user_permissions，带期限与理由）
//   角色徽标显示基线角色；**有追加或分区授权时才出现下拉**，展开看全部
//   颜色：角色用 badge_color（有则上色/无则中性）；头衔用 titles.color；用户名默认色可自定义
//   未激活：只做暗色
// 已删除的废弃项：多角色并列、Username 的三变体、头衔的 plain/gradient/glow 三版。
const A = (p: string) => assetUrl(p);

const SUPER = { key: 'superadmin', name: '超级管理员', color: '#dc2626' };
const ADMIN = { key: 'admin', name: '管理员', color: '#2563eb' };
const CREATOR = { key: 'creator', name: '认证创作者', color: '#7c3aed' };
const USER = { key: 'user', name: '普通用户' };

// 演示数据：一个基线角色 + 两条追加权限（其中一条带到期）
const EXTRA = [
  { key: 'topic.pin', name: '置顶主题', expires: null },
  { key: 'donation.review', name: '核验打赏', expires: '2026-11-15' },
];
const BOARD_GRANTS = [{ board: '自制战役', expires: null }];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5 border-b border-border py-2.5 last:border-0'>
      <span className='flex flex-wrap items-baseline gap-2'>
        <span className='text-[12px] font-medium text-foreground'>{label}</span>
        {hint ? <span className='text-[11px] text-muted-foreground'>{hint}</span> : null}
      </span>
      <span className='flex flex-wrap items-center gap-x-6 gap-y-2'>{children}</span>
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

// 权限下拉：默认收起，只有该用户有追加权限或分区授权时才出现。
// 现在是原生 <details>（候选）；等 Ring UI Dropdown 在 DevRoom 验证并登记后再换。
function PermissionDetails() {
  return (
    <details className='group inline-block align-middle'>
      <summary className='flex cursor-pointer list-none items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted'>
        权限明细
        <ChevronDown aria-hidden className='size-3 transition-transform group-open:rotate-180' />
      </summary>
      <div className='mt-2 flex w-80 flex-col gap-2 rounded-md border border-border bg-popover p-3 text-[12px] shadow-md'>
        <div className='flex flex-col gap-1'>
          <span className='text-[11px] font-semibold text-muted-foreground'>基线角色</span>
          <span className='flex items-center gap-2'><RoleBadge role={ADMIN} /><span className='text-muted-foreground'>管理员（含其下全部继承权限）</span></span>
        </div>
        <div className='flex flex-col gap-1'>
          <span className='text-[11px] font-semibold text-muted-foreground'>单独追加的权限（{EXTRA.length}）</span>
          {EXTRA.map((e) => (
            <span key={e.key} className='flex items-center justify-between gap-2'>
              <span className='text-foreground'>{e.name}</span>
              <span className='text-muted-foreground tabular-nums'>{e.expires ? e.expires + ' 到期' : '长期'}</span>
            </span>
          ))}
        </div>
        <div className='flex flex-col gap-1'>
          <span className='text-[11px] font-semibold text-muted-foreground'>分区授权（{BOARD_GRANTS.length}）</span>
          {BOARD_GRANTS.map((b) => (
            <span key={b.board} className='flex items-center justify-between gap-2'>
              <span className='text-foreground'>{b.board}</span>
              <span className='text-muted-foreground'>{b.expires ? b.expires + ' 到期' : '长期'}</span>
            </span>
          ))}
        </div>
      </div>
    </details>
  );
}

export default function UserControlsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Card name='Username（用户名）' note='只渲染名字。默认前景色；自定义色由数据传；未激活只做暗色。'>
        <Row label='常规 / 加粗 / 自定义色' hint='不给 color 即默认色'>
          <Username nickname='普通用户' />
          <Username nickname='唐天' strong />
          <Username nickname='唐天' color='#2563eb' />
        </Row>
        <Row label='未激活' hint='只暗一档——不加文字、不加横线'>
          <Username nickname='未激活的人' state='inactive' />
        </Row>
        <Row label='尺寸 / @handle / 超长昵称'>
          <Username nickname='唐天' size='sm' />
          <Username nickname='唐天' size='lg' />
          <Username nickname='唐天' handle='tangtian' />
          <span className='flex min-w-0 max-w-56'><Username nickname='一个特别特别长的昵称用来压测截断行为' /></span>
        </Row>
      </Card>

      <Card
        name='RoleBadge（基线角色）+ 权限下拉'
        note='基线角色唯一（users.role_id）；追加权限走 user_permissions（带期限与理由）。有追加或分区授权时才出现「权限明细」。'
      >
        <Row label='四个内置角色' hint='badge_color 有则上色（前三个），无则中性（普通用户）'>
          <RoleBadge role={SUPER} />
          <RoleBadge role={ADMIN} />
          <RoleBadge role={CREATOR} />
          <RoleBadge role={USER} />
        </Row>
        <Row label='只有基线角色' hint='没有追加 → 不显示下拉箭头'>
          <span className='flex items-center gap-2'><UserAvatar name='新来的' size='sm' /><Username nickname='新来的' /><RoleBadge role={USER} /></span>
        </Row>
        <Row label='基线 + 追加权限 / 分区授权' hint='点开看明细：基线是什么、追加了什么、什么时候到期'>
          <span className='flex items-center gap-2'><UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='唐天' /><RoleBadge role={ADMIN} /><PermissionDetails /></span>
        </Row>
      </Card>

      <Card name='TitleBadge（头衔）' note='titles 表：key/name/color/description；用户只佩戴一个。样式已定稿（描边+浅底，无图标）。'>
        <Row label='常见头衔 / 未配颜色' hint='颜色由 titles.color 给；缺省用主色'>
          <TitleBadge title={{ key: 'consul', name: '执政官', color: '#2563eb' }} />
          <TitleBadge title={{ key: 'elite', name: '精华作者', color: '#7c3aed' }} />
          <TitleBadge title={{ key: 'mapper', name: '地图作者', color: '#059669' }} />
          <TitleBadge title={{ key: 'none', name: '未配颜色' }} />
        </Row>
        <Row label='与用户名并排（顺序由使用方决定）'>
          <span className='flex items-center gap-1.5'><Username nickname='唐天' strong /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span>
        </Row>
      </Card>

      <Card name='UserAvatar（头像）' note='四档尺寸；有图用图，无图按昵称取稳定色。'>
        <Row label='尺寸 / 真图 / 兜底'>
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' />
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='md' />
          <UserAvatar name='林诗' src={A('miyin-chibi-160.webp')} size='lg' />
          <UserAvatar name='新来的' size='xl' />
        </Row>
      </Card>

      <Card name='复用：三种场景，全是上面四个控件拼的' note='没有任何一个是「帖子页专用」；顺序与排布由使用方决定。'>
        <Row label='① 列表行'>
          <span className='flex items-center gap-2'><UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='唐天' /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
        </Row>
        <Row label='② 个人主页头部'>
          <span className='flex items-center gap-3'>
            <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='xl' />
            <span className='flex flex-col items-start gap-1'>
              <Username nickname='唐天' handle='tangtian' size='lg' />
              <span className='flex items-center gap-1.5'><RoleBadge role={ADMIN} /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span>
            </span>
          </span>
        </Row>
        <Row label='③ 管理表格（角色单独一列）'>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='林诗' /><RoleBadge role={CREATOR} /></span>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='未激活的人' state='inactive' /><RoleBadge role={USER} /></span>
        </Row>
      </Card>
    </div>
  );
}

import { assetUrl } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';

// DevRoom 07 · 用户身份控件（各自独立、可复用）
// 配色策略（2026-10-12 定）：
//   · **颜色只出现在头衔上**（titles.color，运营配）；
//   · 角色只用中性徽标 + 文字区分；用户名一律默认色，靠字重表达层级；
//   · 未激活（users.activated_at 为空）置灰 + 划掉 + 标注。
const A = (p: string) => assetUrl(p);

// 角色的 color 是**数据**（将来 roles 表加一列即可），不是控件里写死的；不配就是中性徽标。
const SUPER = { key: 'superadmin', name: '超级管理员', color: '#dc2626' };
const ADMIN = { key: 'admin', name: '管理员', color: '#2563eb' };
const CREATOR = { key: 'creator', name: '认证创作者', color: '#7c3aed' };
const USER = { key: 'user', name: '普通用户' }; // 不配色 → 中性徽标

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

export default function UserControlsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='Username（用户名）· 默认色 + 可选自定义色'
        note='只渲染名字。不按角色上色；需要更强层级时用 strong 加粗，而不是配色。'
      >
        <Row label='常规 / 加粗（作者位）/ 自定义颜色' hint='不给 color 就是默认前景色'>
          <Username nickname='普通用户' />
          <Username nickname='唐天' strong />
          <Username nickname='唐天' color='#2563eb' />
          <Username nickname='林诗' color={CREATOR.color} />
        </Row>
        <Row label='未激活（users.activated_at 为空）' hint='只是暗色——不加文字标记、不加横线'>
          <Username nickname='未激活的人' state='inactive' />
          <Username nickname='唐天' state='inactive' />
          <Username nickname='唐天' state='inactive' color='#2563eb' />
        </Row>
        <Row label='尺寸 / @handle / 超长昵称'>
          <Username nickname='唐天' size='sm' />
          <Username nickname='唐天' size='lg' />
          <Username nickname='唐天' handle='tangtian' />
          <span className='flex min-w-0 max-w-56'><Username nickname='一个特别特别长的昵称用来压测截断行为' /></span>
        </Row>
      </Card>

      <Card
        name='RoleBadge（权限）· 颜色可选，由数据给'
        note='颜色可选、由数据给（roles 记录里的配色字段）。不配就是中性；权限树增减不影响控件；多角色渲染多个。'
      >
        <Row label='自定义配色（数据给）' hint='前三个配了颜色，普通用户没配 → 中性。配色是数据，不是控件里的表'>
          <RoleBadge role={SUPER} />
          <RoleBadge role={ADMIN} />
          <RoleBadge role={CREATOR} />
          <RoleBadge role={USER} />
        </Row>
        <Row label='将来加角色' hint='只给 key 和 name 就是中性徽标；要配色就多给一个 color'>
          <RoleBadge role={{ key: 'translator', name: '翻译组' }} />
        </Row>
        <Row label='多角色同时拥有'>
          <span className='flex items-center gap-1.5'><RoleBadge role={ADMIN} /><RoleBadge role={CREATOR} /></span>
          <span className='flex items-center gap-1.5'><RoleBadge role={SUPER} /><RoleBadge role={ADMIN} /></span>
        </Row>
      </Card>

      <Card
        name='TitleBadge（头衔）· 全站唯一带颜色的身份元素'
        note='titles 表：key/name/color/description；用户只佩戴一个。运营只配一个 color，描边与底色由它派生。'
      >
        <Row label='选定：outline（描边 + 浅底，无图标）'>
          <TitleBadge title={{ key: 'consul', name: '执政官', color: '#2563eb' }} />
          <TitleBadge title={{ key: 'elite', name: '精华作者', color: '#7c3aed' }} />
          <TitleBadge title={{ key: 'mapper', name: '地图作者', color: '#059669' }} />
          <TitleBadge title={{ key: 'plain', name: '没配颜色时用主色' }} />
        </Row>
        <Row label='另外三版（未选，留档）' hint='plain 就是之前「太素」的那版'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='plain' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='gradient' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='glow' />
        </Row>
        <Row label='尺寸 / 与用户名并排' hint='顺序由使用方决定，控件不管排版'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='lg' />
          <span className='flex items-center gap-1.5'><Username nickname='唐天' strong /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span>
        </Row>
      </Card>

      <Card name='UserAvatar（头像）' note='四档尺寸；有图用图，无图按昵称取稳定色（唯一与身份相关的自动色，且不与角色绑定）。'>
        <Row label='尺寸 / 真图 / 兜底'>
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' />
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='md' />
          <UserAvatar name='林诗' src={A('miyin-chibi-160.webp')} size='lg' />
          <UserAvatar name='新来的' size='xl' />
        </Row>
      </Card>

      <Card name='复用：四种场景，全是上面四个控件拼的' note='没有任何一个是「帖子页专用」；顺序与排布由使用方决定。'>
        <Row label='① 列表行'>
          <span className='flex items-center gap-2'><UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='唐天' /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
        </Row>
        <Row label='② 个人主页头部'>
          <span className='flex items-center gap-3'>
            <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='xl' />
            <span className='flex flex-col items-start gap-1'>
              <Username nickname='唐天' handle='tangtian' size='lg' />
              <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
            </span>
          </span>
        </Row>
        <Row label='③ 通知'>
          <span className='text-sm text-muted-foreground'><Username nickname='林诗' /> 回复了你的主题</span>
        </Row>
        <Row label='④ 管理表格（权限单独一列）'>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='林诗' /><RoleBadge role={CREATOR} /></span>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='未激活的人' state='inactive' /><RoleBadge role={USER} /></span>
        </Row>
      </Card>
    </div>
  );
}

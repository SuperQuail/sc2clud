import { assetUrl } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';

// DevRoom 07 · 用户身份控件（各自独立、可复用）
// 数据按真实设计来：
//   权限树 = 超级管理员 / 管理员 / 认证创作者 / 普通用户（**不写死在控件里**，颜色由 key 派生）
//   状态   = 激活 / 未激活（users.activated_at）
//   头衔   = titles 表 key/name/color/description，用户只佩戴一个（equipped_title_id）
const A = (p: string) => assetUrl(p);

const SUPER = { key: 'superadmin', name: '超级管理员' };
const ADMIN = { key: 'admin', name: '管理员' };
const CREATOR = { key: 'creator', name: '认证创作者' };
const USER = { key: 'user', name: '普通用户' };
const NEW_ROLE = { key: 'translator', name: '翻译组' };

const TANG = { handle: 'tangtian', nickname: '唐天', avatar: A('miyin-portrait-320.webp'), role: ADMIN };
const LIN = { handle: 'linshi', nickname: '林诗', avatar: A('miyin-chibi-160.webp'), role: CREATOR };

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
        name='Username（用户名）· 已选变体 B（着色，无图标）'
        note='只渲染名字。颜色来自角色，由 key 派生——权限树加人不用改控件。'
      >
        <Row label='四个真实角色' hint='超级管理员 / 管理员 / 认证创作者 / 普通用户'>
          {[SUPER, ADMIN, CREATOR, USER].map((r) => (
            <span key={r.key} className='flex items-center gap-2'>
              <UserAvatar name={r.name} size='sm' />
              <Username nickname={r.name} role={r} variant='color' />
            </span>
          ))}
        </Row>
        <Row label='未激活（users.activated_at IS NULL）' hint='整名置灰 + 划掉 + 标注；不参与着色'>
          <Username nickname='未激活的人' role={USER} state='inactive' />
          <Username nickname='唐天' role={ADMIN} state='inactive' />
        </Row>
        <Row label='另外两个变体（未选，留档）' hint='A 只靠字重 / C 胶囊高亮'>
          <Username nickname='唐天' role={ADMIN} variant='weight' />
          <Username nickname='林诗' role={CREATOR} variant='pill' />
        </Row>
        <Row label='尺寸 / 带 @handle / 超长昵称'>
          <Username nickname='唐天' role={ADMIN} size='sm' />
          <Username nickname='唐天' role={ADMIN} size='lg' />
          <Username nickname='唐天' handle='tangtian' role={ADMIN} />
          <span className='flex min-w-0 max-w-56 items-center gap-1'><Username nickname='一个特别特别长的昵称用来压测截断行为' role={USER} /></span>
        </Row>
      </Card>

      <Card
        name='RoleBadge（权限）· 颜色由 key 派生'
        note='独立控件。一个用户可以同时有多个角色（user_roles 是关系表），使用方渲染多个即可。'
      >
        <Row label='当前权限树' hint='四个内置角色，各自有稳定颜色'>
          <RoleBadge role={SUPER} />
          <RoleBadge role={ADMIN} />
          <RoleBadge role={CREATOR} />
          <RoleBadge role={USER} />
        </Row>
        <Row
          label='权限树后来加了新角色'
          hint='翻译组是临时编的 key：不用改任何控件代码，它自动得到一个稳定颜色 —— 这是「权限树变动」的答案'
        >
          <RoleBadge role={NEW_ROLE} />
          <span className='text-[11px] text-muted-foreground'>key=translator</span>
        </Row>
        <Row label='多角色同时拥有' hint='按重要度排，使用方决定顺序'>
          <span className='flex items-center gap-1.5'><RoleBadge role={ADMIN} /><RoleBadge role={CREATOR} /></span>
          <span className='flex items-center gap-1.5'><RoleBadge role={SUPER} /><RoleBadge role={ADMIN} /></span>
        </Row>
      </Card>

      <Card
        name='TitleBadge（头衔）· 已选第 3 版 outline（无图标）'
        note='titles 表：key/name/color/description；用户只佩戴一个。运营只配一个 color，描边与底色都由它派生。'
      >
        <Row label='选定的 outline' hint='描边 + 浅底 + 同色文字，不带任何图标'>
          <TitleBadge title={{ key: 'consul', name: '执政官', color: '#2563eb' }} />
          <TitleBadge title={{ key: 'elite', name: '精华作者', color: '#7c3aed' }} />
          <TitleBadge title={{ key: 'mapper', name: '地图作者', color: '#059669' }} />
          <TitleBadge title={{ key: 'plain', name: '没配颜色时用主色' }} />
        </Row>
        <Row label='另外三版（未选，留档）' hint='plain 是之前「太素」的那版'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='plain' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='gradient' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='glow' />
        </Row>
        <Row label='尺寸 / 与用户名并排' hint='顺序由使用方决定，控件不管排版'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='lg' />
          <span className='flex items-center gap-1.5'><Username nickname='唐天' role={ADMIN} /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span>
        </Row>
      </Card>

      <Card name='UserAvatar（头像）' note='四档尺寸；有图用图，无图按昵称取稳定色。'>
        <Row label='尺寸 / 真图 / 兜底'>
          <UserAvatar name='唐天' src={TANG.avatar} size='sm' />
          <UserAvatar name='唐天' src={TANG.avatar} size='md' />
          <UserAvatar name='林诗' src={LIN.avatar} size='lg' />
          <UserAvatar name='新来的' size='xl' />
        </Row>
      </Card>

      <Card name='复用：四种场景，全是上面四个控件拼的' note='没有任何一个是「帖子页专用」；顺序与排布由使用方决定。'>
        <Row label='① 列表行（头像 + 名字）'>
          <span className='flex items-center gap-2'><UserAvatar name='唐天' src={TANG.avatar} size='sm' /><Username nickname='唐天' role={ADMIN} /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
        </Row>
        <Row label='② 个人主页头部（大头像 + 大名字 + 头衔）'>
          <span className='flex items-center gap-3'>
            <UserAvatar name='唐天' src={TANG.avatar} size='xl' />
            <span className='flex flex-col items-start gap-1'>
              <Username nickname='唐天' handle='tangtian' role={ADMIN} size='lg' />
              <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
            </span>
          </span>
        </Row>
        <Row label='③ 通知（最省）'>
          <span className='text-sm text-muted-foreground'><Username nickname='林诗' role={CREATOR} /> 回复了你的主题</span>
        </Row>
        <Row label='④ 管理表格（权限单独一列）'>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='林诗' variant='weight' /><RoleBadge role={CREATOR} /></span>
          <span className='flex w-72 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='未激活的人' state='inactive' /><RoleBadge role={USER} /></span>
        </Row>
      </Card>
    </div>
  );
}

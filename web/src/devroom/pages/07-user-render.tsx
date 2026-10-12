import { assetUrl } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username, type UsernameVariant } from '@/ui/user/username';

// DevRoom 07 · 用户身份控件（各自独立、可复用）
// 这一页**不模拟帖子页**：四个控件是分开的，任何地方都能单独拿去用。
// 用户名给三个**明显不同**的样式变体供选择；权限/头衔/头像各自独立成控件。
const A = (p: string) => assetUrl(p);

const ADMIN = { handle: 'tangtian', nickname: '唐天', role: { key: 'admin', name: '管理员' } };
const MOD = { handle: 'linshi', nickname: '林诗', role: { key: 'moderator', name: '版主' } };
const PLAIN = { handle: 'newbie', nickname: '新来的', role: { key: 'user', name: '会员' } };
const LONG = { handle: 'a-very-long-handle-here', nickname: '一个特别特别长的昵称用来压测截断行为', role: { key: 'member', name: '会员' } };
const ALL = [ADMIN, MOD, PLAIN, LONG];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5 border-b border-border py-2.5 last:border-0'>
      <span className='flex items-baseline gap-2'>
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

const VARIANTS: Array<{ key: UsernameVariant; name: string; note: string }> = [
  { key: 'weight', name: '变体 A · 只靠字重', note: '不着色，管理员加粗、版主半粗；最含蓄，适合密集列表' },
  { key: 'color', name: '变体 B · 名字着色 + 角色图标', note: '管理员红、版主蓝，名字后跟盾牌/星标；一眼看出身份' },
  { key: 'pill', name: '变体 C · 胶囊高亮', note: '名字带角色底色胶囊；最显眼，适合作者位与个人主页' },
];

export default function UserControlsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Card name='Username（用户名）— 三个样式变体' note='独立控件：只渲染「名字」，不负责权限与头衔的排版。三版视觉差异是一眼可辨的。'>
        {VARIANTS.map((v) => (
          <Row key={v.key} label={v.name} hint={v.note}>
            {ALL.map((u) => (
              <span key={u.handle} className='flex items-center gap-2'>
                <UserAvatar name={u.nickname} src={u.handle === 'tangtian' ? A('miyin-portrait-320.webp') : undefined} size='sm' />
                <Username nickname={u.nickname} role={u.role} variant={v.key} />
              </span>
            ))}
          </Row>
        ))}
        <Row label='尺寸' hint='sm / md / lg / xl，四处场景共用同一控件'>
          <Username nickname='唐天' role={ADMIN.role} size='sm' variant='color' />
          <Username nickname='唐天' role={ADMIN.role} size='md' variant='color' />
          <Username nickname='唐天' role={ADMIN.role} size='lg' variant='color' />
          <Username nickname='唐天' role={ADMIN.role} size='xl' variant='color' />
        </Row>
        <Row label='带 @handle' hint='个人主页、资料卡用'>
          <Username nickname='唐天' handle='tangtian' role={ADMIN.role} variant='color' />
          <Username nickname='林诗' handle='linshi' role={MOD.role} variant='pill' />
        </Row>
        <Row label='无角色 / 超长昵称' hint='未上色、自动截断不挤压后面内容'>
          <Username nickname='路人甲' />
          <span className='flex min-w-0 max-w-56 items-center gap-1'><Username nickname={LONG.nickname} role={PLAIN.role} variant='color' /><span className='shrink-0 text-xs text-muted-foreground'>· 2 小时前</span></span>
        </Row>
      </Card>

      <Card name='RoleBadge（权限）— 独立控件' note='自己就是一个组件；放名字前、名字后、单独一行、表格列都行。注意 user_roles 是关系表——一个用户可以同时有两个角色，使用方可能要渲染多个。'>
        <Row label='四个真实角色' hint='数据库内置 roles：user / moderator / admin / superadmin；未知 key 走灰色兜底'>
          <RoleBadge role={{ key: 'admin', name: '管理员' }} />
          <RoleBadge role={{ key: 'moderator', name: '版主' }} />
          <RoleBadge role={{ key: 'user', name: '会员' }} />
          <RoleBadge role={{ key: 'superadmin', name: '超级管理员' }} />
          <RoleBadge role={{ key: 'custom', name: '未知角色' }} />
        </Row>
        <Row label='与 Username 并排（由使用方决定顺序，不是控件的职责）'>
          <span className='flex items-center gap-1.5'><RoleBadge role={ADMIN.role} /><Username nickname='唐天' role={ADMIN.role} variant='weight' /></span>
          <span className='flex items-center gap-1.5'><Username nickname='林诗' role={MOD.role} variant='weight' /><RoleBadge role={MOD.role} /></span>
        </Row>
      </Card>

      <Card
        name='TitleBadge（头衔）— 四版对照，挑一版'
        note='数据来自 titles 表：key / name / color / description（用户只佩戴一个）。颜色只配一个，渐变与光晕都由它派生。'
      >
        <Row label='① plain（现在的样子 · 太素）' hint='平底色方块，与权限徽标抢不出层级'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='plain' />
          <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} variant='plain' />
          <TitleBadge title={{ name: '地图作者', color: '#059669' }} variant='plain' />
        </Row>
        <Row label='② gradient（渐变实心 + 内高光）' hint='最有份量；深色底上尤其清楚'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='gradient' />
          <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} variant='gradient' />
          <TitleBadge title={{ name: '地图作者', color: '#059669' }} variant='gradient' />
          <TitleBadge title={{ name: '无颜色时用主色' }} variant='gradient' />
        </Row>
        <Row label='③ outline（描边 + 星标）' hint='最轻，适合密集列表里也放一个'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='outline' />
          <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} variant='outline' />
          <TitleBadge title={{ name: '地图作者', color: '#059669' }} variant='outline' />
        </Row>
        <Row label='④ glow（实色 + 外发光）' hint='最跳；适合站内极少数的特殊称号'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='glow' />
          <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} variant='glow' />
          <TitleBadge title={{ name: '地图作者', color: '#059669' }} variant='glow' />
        </Row>
        <Row label='尺寸 / 与用户名并排' hint='三种尺寸，以及和 Username 放在一起的实际观感'>
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' variant='gradient' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='md' variant='gradient' />
          <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='lg' variant='gradient' />
        </Row>
        <Row label='和名字一起（顺序由使用方决定）'>
          <span className='flex items-center gap-1.5'><Username nickname='唐天' role={ADMIN.role} variant='weight' /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} variant='gradient' /></span>
          <span className='flex items-center gap-1.5'><TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} variant='outline' /><Username nickname='林诗' role={MOD.role} variant='weight' /></span>
        </Row>
      </Card>

      <Card name='UserAvatar（头像）— 独立控件' note='四档尺寸，有图用图、无图按昵称取稳定色。'>
        <Row label='尺寸 / 真图 / 兜底'>
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' />
          <UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='md' />
          <UserAvatar name='林诗' src={A('miyin-chibi-160.webp')} size='lg' />
          <UserAvatar name='新来的' size='xl' />
        </Row>
      </Card>

      <Card name='复用示例：同一批控件，四种场景' note='下面每一处都是把上面四个控件拼起来用的，**没有任何一个是“帖子页专用”**。'>
        <Row label='① 列表行（头像 + 名字 + 权限）'>
          <span className='flex items-center gap-2'><UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='sm' /><Username nickname='唐天' role={ADMIN.role} variant='color' /><span className='text-xs text-muted-foreground'>2 小时前</span></span>
        </Row>
        <Row label='② 个人主页头部（大头像 + 大名字 + 头衔）'>
          <span className='flex items-center gap-3'><UserAvatar name='唐天' src={A('miyin-portrait-320.webp')} size='xl' /><span className='flex flex-col gap-1'><Username nickname='唐天' handle='tangtian' role={ADMIN.role} size='lg' variant='pill' /><TitleBadge title={{ name: '执政官', color: '#2563eb' }} /></span></span>
        </Row>
        <Row label='③ 通知（只有名字，最省）'>
          <span className='text-sm text-muted-foreground'><Username nickname='林诗' role={MOD.role} variant='color' /> 回复了你的主题</span>
        </Row>
        <Row label='④ 管理表格列（权限单独占一列）'>
          <span className='flex w-64 items-center justify-between gap-2 rounded border border-border px-2 py-1 text-sm'><Username nickname='林诗' variant='weight' /><RoleBadge role={MOD.role} /></span>
        </Row>
      </Card>
    </div>
  );
}

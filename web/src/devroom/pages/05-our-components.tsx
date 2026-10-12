import { Heart, Plus, Send } from 'lucide-react';
import { ThemeSwitcher } from '@/ui/theme-switcher';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserBadge, type UserSummary } from '@/ui/user/user-badge';
import { VividButton } from '@/ui/vivid/button';

// DevRoom 05 · 我们自己的组合件
// 原则：**拆成小控件 + 换排布**，而不是为每个场景重新设计一个用户展示。
function Area({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-3'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{title}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{desc}</p>
      </div>
      <div className='flex flex-wrap items-center gap-5'>{children}</div>
    </section>
  );
}

const ME: UserSummary = {
  handle: 'tangtian',
  nickname: '唐天',
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
const MOD: UserSummary = { handle: 'linshi', nickname: '林诗', role: { key: 'moderator', name: '版主' } };
const PLAIN: UserSummary = { handle: 'newbie', nickname: '新来的' };

export default function OurComponentsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Area
        title='主题切换（点击循环）'
        desc='一个按钮：日间 → 夜间 → 跟随系统 → 日间。图标显示当前状态，点击切下一个。'
      >
        <ThemeSwitcher />
      </Area>

      <Area
        title='头像（自建，用户向）'
        desc='不用 Ring UI 的 Avatar：四档尺寸、无图时按昵称取稳定色、支持真图。'
      >
        <UserAvatar name='唐天' size='sm' />
        <UserAvatar name='唐天' size='md' />
        <UserAvatar name='林诗' size='lg' />
        <UserAvatar name='新来的' size='xl' />
      </Area>

      <Area
        title='权限徽标（独立控件）'
        desc='权限是角色，不是等级——我们没有 level 系统。颜色按角色 key 自动取。'
      >
        <RoleBadge role={{ key: 'admin', name: '管理员' }} />
        <RoleBadge role={{ key: 'moderator', name: '版主' }} />
        <RoleBadge role={{ key: 'member', name: '会员' }} />
        <RoleBadge role={{ key: 'custom', name: '未知角色' }} />
      </Area>

      <Area
        title='头衔徽标（独立控件）'
        desc='头衔是运营/活动给的称号，可自定义颜色，与权限互不影响。'
      >
        <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
        <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} />
        <TitleBadge title={{ name: '地图作者', color: '#059669' }} />
        <TitleBadge title={{ name: '无颜色时用主色' }} />
      </Area>

      <Area
        title='用户渲染：同一套控件换排布'
        desc='badges=after / before / below / none，layout=inline / stacked，size 四档。不同场景只换参数。'
      >
        <UserBadge user={ME} showHandle />
        <UserBadge user={ME} badges='before' />
        <UserBadge user={ME} badges='below' />
        <UserBadge user={ME} badges='none' />
        <UserBadge user={MOD} size='sm' />
        <UserBadge user={PLAIN} size='sm' />
        <UserBadge user={ME} layout='stacked' size='lg' showHandle />
      </Area>

      <Area
        title='设计语言 B · 用户向按钮（Tailwind 自建）'
        desc='鲜艳、大、圆润。用于首页 / 分区页 / 帖子页等普通访客看得到的地方。'
      >
        <VividButton icon={Plus}>发帖</VividButton>
        <VividButton size='lg' icon={Send}>立即加入</VividButton>
        <VividButton tone='accent' icon={Heart}>赞赏作者</VividButton>
        <VividButton tone='soft'>收藏</VividButton>
        <VividButton tone='ghost'>稍后再说</VividButton>
        <VividButton tone='danger'>删除</VividButton>
        <VividButton loading>提交中</VividButton>
        <VividButton disabled>不可用</VividButton>
        <VividButton size='icon' icon={Heart} aria-label='收藏' />
      </Area>
    </div>
  );
}

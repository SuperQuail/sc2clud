import { assetUrl } from '@/lib/url';
import { Heart, Plus, Send } from 'lucide-react';
import { ThemeSwitcher } from '@/ui/theme-switcher';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserBadge, type UserSummary } from '@/ui/user/user-badge';
import { VividButton } from '@/ui/vivid/button';

// DevRoom 05 · 我们自己的组合件 + 美术资产
// 原则：拆成小控件 + 换排布，不为每个场景重新设计。
// 图片用**相对路径**（art/...）：生产在 /、dev 在 /dev/，靠 <base href> 解析，两处都对。

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
  avatar: assetUrl('miyin-portrait-320.webp'),
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
const MOD: UserSummary = { handle: 'linshi', nickname: '林诗', role: { key: 'moderator', name: '版主' } };
const PLAIN: UserSummary = { handle: 'newbie', nickname: '新来的' };

export default function OurComponentsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Area title='主题切换（点击循环）' desc='一个按钮：日间 → 夜间 → 跟随系统 → 日间。'>
        <ThemeSwitcher />
      </Area>

      <Area title='头像（自建，用户向）' desc='四档尺寸；有真图用真图，没有就按昵称取稳定色。'>
        <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='sm' />
        <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='md' />
        <UserAvatar name='林诗' src={assetUrl('miyin-chibi-160.webp')} size='lg' />
        <UserAvatar name='新来的' size='xl' />
      </Area>

      <Area title='权限徽标（独立控件）' desc='权限是角色，不是等级。未知角色走灰色兜底。'>
        <RoleBadge role={{ key: 'admin', name: '管理员' }} />
        <RoleBadge role={{ key: 'moderator', name: '版主' }} />
        <RoleBadge role={{ key: 'member', name: '会员' }} />
        <RoleBadge role={{ key: 'custom', name: '未知角色' }} />
      </Area>

      <Area title='头衔徽标（独立控件）' desc='头衔是运营/活动给的称号，可自定义颜色。'>
        <TitleBadge title={{ name: '执政官', color: '#2563eb' }} />
        <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} />
        <TitleBadge title={{ name: '地图作者', color: '#059669' }} />
        <TitleBadge title={{ name: '无颜色时用主色' }} />
      </Area>

      <Area
        title='用户渲染：同一套控件换排布'
        desc='badges=after / before / below / none，layout=inline / stacked，size 四档。'
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
        title='美术资产 · 星海（复用老项目，Blizzard 官方素材）'
        desc='来源与授权见 public/art/starcraft/SOURCES.md：仅作等比缩小与 WebP 压缩，版权归 Blizzard。'
      >
        <img src={assetUrl('starcraft/sc2-logo.webp')} alt='StarCraft II' width={180} height={52} className='h-10 w-auto' />
        <img src={assetUrl('starcraft/terran.webp')} alt='人类' width={48} height={48} className='size-10' />
        <img src={assetUrl('starcraft/protoss.webp')} alt='神族' width={48} height={48} className='size-10' />
        <img src={assetUrl('starcraft/zerg.webp')} alt='虫族' width={48} height={48} className='size-10' />
        <img src={assetUrl('starcraft/sc2-battle.webp')} alt='对战场景' width={320} height={120} className='h-24 w-64 rounded-md object-cover' />
      </Area>

      <Area
        title='美术资产 · 版块导航插画（每个版块一张）'
        desc='可以直接用作版块图标/入口；命名与版块 slug 对应（nav-custom_campaign → 自制战役）。'
      >
        {['nav-custom_campaign', 'nav-tool_dev', 'nav-tool_player', 'nav-vanilla_mod', 'nav-profile', 'nav-bookmarks', 'nav-announcement', 'nav-admin'].map((n) => (
          <span key={n} className='flex flex-col items-center gap-1'>
            <img src={assetUrl('starcraft/' + n + '.webp')} alt={n} width={40} height={40} className='size-10 rounded-md object-contain' />
            <span className='text-[10px] text-muted-foreground'>{n.replace('nav-', '')}</span>
          </span>
        ))}
      </Area>

      <Area
        title='美术资产 · 吉祥物与空状态插画'
        desc='SOURCES.md 里已写明用途：welcome-400=注册欢迎、wisdom-160=搜索无结果、smile-160=通知/收藏空状态、image-unavailable-480=配图失败占位。'
      >
        {[['welcome-400', '注册欢迎'], ['wink-520', '首页欢迎'], ['wisdom-160', '搜索无结果'], ['smile-160', '空状态'], ['genius-160', '创作提示'], ['image-unavailable-480', '配图失败占位']].map(([f, label]) => (
          <span key={f} className='flex w-28 flex-col items-center gap-1'>
            <img src={assetUrl('miyin/' + f + '.webp')} alt={label} width={96} height={96} className='h-20 w-20 object-contain' />
            <span className='text-[10px] text-muted-foreground'>{label}</span>
          </span>
        ))}
      </Area>

      <Area title='设计语言 B · 用户向按钮' desc='鲜艳、大、圆润。用于普通访客看得到的地方。'>
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

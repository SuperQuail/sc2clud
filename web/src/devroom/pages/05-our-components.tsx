import { Heart, Plus, Send } from 'lucide-react';
import { ThemeSwitcher } from '@/ui/theme-switcher';
import { UserBadge } from '@/ui/user-badge';
import { VividButton } from '@/ui/vivid/button';

// DevRoom 05 · 我们自己的组合件（不是 Ring UI 的控件，是我们按业务语义封装的）
// 这一页同时是**两套设计语言的对照**：A = Ring UI（专业/密集），B = Tailwind 自建（鲜艳/大/圆润）。
function Area({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-3'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{title}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{desc}</p>
      </div>
      <div className='flex flex-wrap items-center gap-4'>{children}</div>
    </section>
  );
}

const ME = {
  handle: 'tangtian',
  nickname: '唐天',
  level: 12,
  role: { key: 'moderator', name: '版主' },
  title: { name: '执政官', color: '#2563eb' },
};

export default function OurComponentsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Area
        title='主题：日间 / 夜间 / 跟随系统'
        desc='点一下就能切。跟随系统时会监听系统切换；偏好写在 localStorage，首屏由内联脚本应用（不闪白）。'
      >
        <ThemeSwitcher />
        <ThemeSwitcher compact />
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

      <Area
        title='用户渲染：昵称 / 权限等级 / 头衔'
        desc='全站统一走这个控件；头像由 Ring UI Avatar 承担，昵称/等级/头衔的排版与配色收口在这里。'
      >
        <UserBadge user={ME} showHandle />
        <UserBadge user={ME} />
        <UserBadge user={{ handle: 'newbie', nickname: '新来的', level: 1 }} />
        <UserBadge user={ME} layout='stacked' size='lg' showHandle />
      </Area>
    </div>
  );
}

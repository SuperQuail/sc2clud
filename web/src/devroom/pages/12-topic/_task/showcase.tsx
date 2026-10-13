import { useState, type ReactNode } from 'react';
import { Card } from '@/devroom/kit';
import { assetUrl } from '@/lib/url';
import { TopicTaskTabs, type TopicTaskTab } from './task-tabs';
import { IssueKindButton } from './issue-kind-button';
import { IssueCard } from './issue-card';
import { ISSUE_KIND_META, type IssueKind, type IssueSummary } from './types';

// W1 · 帖子页共享件的**验证现场**（页面 key = 12-topic）。
// 只放控件与它们的两态/多档，不放三栏页面本体——本体由 W2 组装，合并时删掉这个 import 即可。
// 数据：页面内 mock（字段名照 完全重构/论坛后端技术方案-v2.md §21.2），不 fetch、不接 api client。
const KINDS: IssueKind[] = ['bug', 'feature', 'difficulty', 'other'];

const ISSUES: IssueSummary[] = [
  {
    id: 128,
    kind: 'bug',
    title: '第三章第 4 关「余烬」读档后卡在过场黑屏，重进仍复现',
    status: 'open',
    author: { handle: 'demo-admin', nickname: '示范管理员', avatar: assetUrl('miyin-portrait-320.webp'), role: { key: 'admin', name: '管理员' } },
    commentCount: 6,
    createdAt: '今天 09:12',
    updatedAt: '3 分钟前',
  },
  {
    id: 122,
    kind: 'difficulty',
    title: '第 7 关菌毯推进太快：第 3 波与第 4 波之间建议留 30 秒',
    status: 'open',
    author: { handle: 'demo-marine', nickname: '陆战队员' },
    commentCount: 3,
    createdAt: '昨天 21:40',
    updatedAt: '2 小时前',
  },
  {
    id: 96,
    kind: 'feature',
    title: '希望资源帖支持附件直链（已实现，见 10-10 更新日志）',
    status: 'closed',
    author: { handle: 'demo-voidray', nickname: '虚空辉光舰', avatar: null },
    commentCount: 9,
    createdAt: '2026-10-08',
    updatedAt: '2026-10-10',
  },
];

/** 验证现场的分节标题（就地布局；kit 的 Row 把子元素包在 span 里，装不下 nav/div，所以这里自己排） */
function Block({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-2 border-b border-border py-3 last:border-0'>
      <span className='flex flex-wrap items-baseline gap-2'>
        <span className='text-[12px] font-medium text-foreground'>{label}</span>
        <span className='text-[11px] text-muted-foreground'>{hint}</span>
      </span>
      {children}
    </div>
  );
}

export function TopicTaskShowcase() {
  const [tab, setTab] = useState<TopicTaskTab>('content');
  const [opened, setOpened] = useState(0);
  const [kind, setKind] = useState<IssueKind | null>(null);

  return (
    <div className='flex flex-col gap-4'>
      <p className='text-[13px] leading-relaxed text-muted-foreground'>
        W1 共享件验证现场：顶部双按钮（TopicTaskTabs）、四个 Issue 入口（IssueKindButton）、Issue 列表项（IssueCard）。
        全部是数据驱动的受控件；颜色只取自 Ring UI 主题变量，深浅两套都出图看过。
      </p>

      <Card name='TopicTaskTabs · 顶部双按钮' note='左「帖子内容」右「Issue」；当前项用 primary 填充 + aria-current，计数 0 时不显示药丸。'>
        <Block label='两种选中态并排' hint='左：content 选中；右：issue 选中（带 7 条未关闭）'>
          <div className='flex flex-wrap gap-8'>
            <div className='min-w-[260px] flex-1'>
              <TopicTaskTabs value='content' onChange={() => {}} onOpenIssue={() => {}} issueCount={7} />
            </div>
            <div className='min-w-[260px] flex-1'>
              <TopicTaskTabs value='issue' onChange={() => {}} onOpenIssue={() => {}} issueCount={7} />
            </div>
          </div>
        </Block>
        <Block label='受控交互' hint='点 Issue 会依次调 onChange + onOpenIssue；issueCount=0 时药丸消失'>
          <div className='flex max-w-[420px] flex-col gap-1'>
            <TopicTaskTabs value={tab} onChange={setTab} onOpenIssue={() => setOpened((n) => n + 1)} issueCount={0} />
            <span className='text-[11px] text-muted-foreground'>
              当前 value：{tab} · onOpenIssue 已调用 {opened} 次
            </span>
          </div>
        </Block>
      </Card>

      <Card name='IssueKindButton · 四个入口' note='每种 kind 独立的颜色与图标（红/蓝/橙/紫，取自 Ring UI 主题变量）；键盘可达，焦点环由控件负责。'>
        <Block label='lg 档 · 新建入口' hint='点击后在下面显示选中的 kind（onSelect 回传 kind）'>
          <div className='flex flex-wrap items-center gap-2'>
            {KINDS.map((k) => (
              <IssueKindButton key={k} kind={k} size='lg' onSelect={setKind} />
            ))}
          </div>
          <span className='text-[11px] text-muted-foreground'>
            当前选择：{kind ? ISSUE_KIND_META[kind].label : '未选择'}
          </span>
        </Block>
        <Block label='size 三档 · sm / md / lg' hint='以「报个 Bug」为例；不传 onSelect 即纯展示（不可点）'>
          <div className='flex flex-wrap items-center gap-2'>
            <IssueKindButton kind='bug' size='sm' />
            <IssueKindButton kind='bug' size='md' />
            <IssueKindButton kind='bug' size='lg' />
          </div>
        </Block>
      </Card>

      <Card name='IssueCard · Issue 列表项' note='纯展示：左状态图标（open 绿 / closed 紫）+ 标题 + 类型标签 + 作者 + #编号 + 评论数 + 更新时间；点击行为留给列表容器。'>
        <div className='overflow-hidden rounded-md border border-border'>
          {ISSUES.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </div>
      </Card>
    </div>
  );
}

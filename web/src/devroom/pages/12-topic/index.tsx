import { useState } from 'react';
import { appPath } from '@/lib/url';
import { TopicTaskTabs, type TopicTaskTab } from './_task/task-tabs';
import { AuthorCard } from './author-card';
import { BoardSummary } from './board-summary';
import { IssueNudge } from './issue-nudge';
import { LeftRail } from './left-rail';
import { MainColumn, TopicMeta } from './main-column';
import { AUTHOR, BOARDS, BOARD_NAV, CANDIDATES, CHANNELS, MY_ACCOUNT, topicBody, topicComments } from './mock';
import { RewardPanel } from './reward-panel';
import { TopicTaskShowcase } from './_task/showcase';
import type { TopicDetail, TopicSource } from './types';

// DevRoom 12 · 帖子内容页（贴吧式三栏）
//
// 结构：顶部两个大按钮（帖子内容 / 问题反馈，来自 _task/task-tabs）→ 三栏
//   左栏 分区列表 + 分区内导航（**只在 ≥1200px 出现**，贴吧式常驻栏）
//   中栏 主题全文 + 下载来源 + 动作条 + 评论区（评论区复用 @/ui/comment，不另写一套）
//   右栏 分区简介 → 发帖者卡片 → 赞助入口 → 问题反馈入口
//
// 三档响应式：<768 单列／768–1279 两栏（左栏仍不出现）／≥1280 三栏。
// 页宽不再由本页自己挣：DevRoom 与真实壳（src/app/shell.tsx）**都是 max-w-[1280px]**，
// 所以这里量到的列宽就是真站的列宽（此前房间锁 1100px，页面靠负边距外扩，量出来的数不作数）。

const BOARD = BOARDS.find((b) => b.slug === 'custom-campaign') ?? BOARDS[0]!;

// 下载来源：go_path 走服务端转链端点（后端 §21.2 的 assets/go 同款形状），前端不暴露真实直链
const SOURCES: TopicSource[] = [
  {
    id: 's1',
    provider: 'netdisk',
    label: '第三章整合包（含 18 张地图 + 完整语音）',
    go_path: appPath('api/v1/topics/t_1042/sources/s1/go'),
    extraction_code: 'sc2c',
    size: '2.4 GB',
    verified_at: '今天 09:20',
    upkeep: 'active',
  },
  {
    id: 's2',
    provider: 'github',
    label: '触发器源码与本地化文本（MIT）',
    go_path: appPath('api/v1/topics/t_1042/sources/s2/go'),
    extraction_code: null,
    size: '18 MB',
    verified_at: '3 天前',
    upkeep: 'active',
  },
  {
    id: 's3',
    provider: 'netdisk',
    label: '旧版第二章补丁（仅存档修复用）',
    go_path: appPath('api/v1/topics/t_1042/sources/s3/go'),
    extraction_code: 'c2fix',
    size: '64 MB',
    verified_at: '2026-08-30',
    upkeep: 'archived',
  },
];

const TOPIC: TopicDetail = {
  id: 't_1042',
  board: { slug: 'custom-campaign', name: '自制战役' },
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明：菌毯推进速度与第 11 关调整',
  content_html: topicBody(appPath),
  author: AUTHOR,
  created_at: '2026-10-12 09:20',
  updated_at: '今天 11:04',
  reply_count: 128,
  like_count: 236,
  view_count: 4203,
  bookmark_count: 74,
  pinned: true,
  featured: true,
  locked: false,
  sources: SOURCES,
  images: [],
  viewer: { liked: false, bookmarked: true, following: false },
};

/** 未关闭的 Issue 数：顶栏 Issue 按钮上的计数（真值来自 GET /api/v1/topics/{id}/issues?status=open） */
const ISSUE_OPEN_COUNT = 7;

export default function TopicPage() {
  const [tab, setTab] = useState<TopicTaskTab>('content');
  const [nav, setNav] = useState('all');
  // 共享件的验证现场仍要能打开：page=12-topic&view=showcase。
  // 独立入口（一个只挂着 showroom 的 index）被删掉了——同一页两个身份，出图时会看不出谁是主页面。
  const showcase = new URLSearchParams(location.search).get('view') === 'showcase';

  return (
    <div className='flex w-full flex-col gap-4'>
      <TopicTaskTabs
        value={tab}
        onChange={setTab}
        issueCount={ISSUE_OPEN_COUNT}
        onOpenIssue={() => {
          // devroom 里没有路由：用一次跳转模拟「去反馈页」。（真页面走 react-router 的 navigate）
          window.location.assign(appPath('?page=13-issue'));
        }}
      />

      <div className='grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-[minmax(0,1fr)_248px] xl:flex xl:items-start'>
        {/* 左栏：只在 ≥1200px 出现。用 hidden 而不是挪到底部——它是「常驻栏」，不该在窄屏抢首屏 */}
        <aside aria-label='分区与分区内导航' className='hidden xl:block xl:w-[200px] xl:shrink-0'>
          <LeftRail boards={BOARDS} currentSlug={BOARD.slug} nav={BOARD_NAV} navValue={nav} onNavChange={setNav} />
        </aside>

        {/* 中栏：主区。窄屏靠 row-start 抢回第一格，右栏因此落在它下面、评论之前 */}
        <main data-testid='topic-main' className='flex min-w-0 flex-col gap-3 md:col-start-1 md:row-start-1 xl:flex-1'>
          <TopicMeta topic={TOPIC} />
          <MainColumn
            topic={TOPIC}
            comments={topicComments(appPath)}
            commentTotal={TOPIC.reply_count}
            candidates={CANDIDATES}
            me={MY_ACCOUNT}
            issueCount={ISSUE_OPEN_COUNT}
          />
        </main>

        {/* 右栏：分区简介 → 发帖者卡片 → 赞助 → 问题反馈入口。长帖里跟着滚 */}
        <aside
          data-testid='topic-rail'
          className='flex min-w-0 flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1 xl:sticky xl:top-4 xl:w-[248px] xl:shrink-0'
        >
          <BoardSummary board={BOARD} />
          <AuthorCard author={AUTHOR} />
          <RewardPanel channels={CHANNELS} />
          <IssueNudge variant='rail' issueCount={ISSUE_OPEN_COUNT} />
        </aside>
      </div>

      {showcase ? <TopicTaskShowcase /> : null}
    </div>
  );
}
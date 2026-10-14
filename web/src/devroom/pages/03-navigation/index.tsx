import { useState } from 'react';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import PagerRing from '@jetbrains/ring-ui-built/components/pager/pager';
import { AppPager } from '@/ui/pager';
import Panel from '@jetbrains/ring-ui-built/components/panel/panel';
// 注意：Tabs 是**命名导出**（没有 default），Tab 也一样
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { Card, Row } from '@/devroom/kit';
import { roomHref } from '@/devroom/room-links';
import { assetUrl } from '@/lib/url';
import { BoardRail, type BoardSummary } from './board-rail';

// DevRoom 03 · 导航与结构（README 规划的第三页）
// 这一类控件共享「位置感」：我在哪、能去哪、内容装在什么容器里。
// 全部 Ring 原生：**Tab 没有 selected 属性**，选中态由 Tabs 的 selected + onSelect 管。
//
// 分区侧栏（board-rail.tsx）是**产品页共用同一个文件**的 View：这里与 routes/home.tsx、
// routes/board.tsx 渲染的是同一份代码（清单 §0 的同源要求），差别只有数据。
// 三档数据都在下面：有封面 / 没有封面（真站现在全是这一档）/ 一个分区都没有。

/**
 * 数据形状照后端 BoardDTO（forum/internal/forum/dto.go:38）：**cover_hash 是裸哈希**。
 *
 * 「有封面」那一行借用站内素材当 hash（去掉 art/ 前缀）—— 房间是**公开部署的设计预览页**，
 * 服务端没有图片接口（/img/<hash> 在静态服务上不存在），拿一张真素材才能把「有封面」这一态画出来。
 * 产品页走的是同一条渲染路径，只是 hash 来自后端。真站现在五个分区的 cover_hash **全是空串**。
 */
const DEMO_BOARDS: BoardSummary[] = [
  { slug: 'announcement', name: '公告', cover_hash: assetUrl('miyin/portrait-160.webp').replace('art/', ''), description: '版本发布、维护窗口与规则变动', topic_count: 4 },
  { slug: 'vanilla-mod', name: '原版战役 mod', cover_hash: '', description: '不改剧情、只改体验：平衡、AI、画面与手感', topic_count: 5 },
  { slug: 'custom-campaign', name: '自制战役', cover_hash: '', description: '玩家自制战役与地图', topic_count: 10 },
  { slug: 'emperor', name: '皇帝区', cover_hash: '', description: '', topic_count: 0 },
];

export default function NavigationPage() {
  const [tab, setTab] = useState('topics');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);

  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='分区侧栏 BoardRail（首页 / 分区页共用）'
        note='产品页渲染的就是这个文件（routes/_parts/layout.tsx 只负责取数传参）。封面字段是后端 BoardDTO 的 cover_hash（裸哈希）；为空时是「首字 + slug 色相」的稳定占位，不是空白。宽度 168px 与真站一致。'
      >
        <Row label='有数据：三个分区里第一个有封面、后面没有（= 真站现在的数据）' hint='当前分区加高亮与左侧色条'>
          <div className='rounded-md border border-border p-2'>
            <BoardRail boards={DEMO_BOARDS} current='custom-campaign' className='w-[168px]' />
          </div>
        </Row>
        <Row label='没有数据：整块不渲染（不画骨架、不占位）' hint='它是辅助导航，不该抢首屏注意力'>
          <div className='flex h-24 w-[240px] items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground'>
            这一格在真站上是空的
          </div>
          <BoardRail boards={[]} />
        </Row>
      </Card>

      <Card name='标签页 Tabs' note='切换同一页面内的视图，不换 URL（切 URL 用链接）。选中态在 Tabs 上，Tab 只给 id/title。'>
        <Row label='选中 / 禁用 / 带计数' hint='selected + onSelect 都由 Tabs 管'>
          <div className='w-full'>
            <Tabs selected={tab} onSelect={(id: string) => setTab(String(id))}>
              <Tab id='topics' title='帖子' />
              <Tab id='essence' title='精华' />
              <Tab id='following' title='关注' />
              <Tab id='archived' title='归档（不可用）' disabled />
            </Tabs>
          </div>
        </Row>
        <Row label='当前选中'>
          <span className='text-[12px] text-muted-foreground'>{tab}</span>
        </Row>
      </Card>

      <Card name='面包屑 Breadcrumbs' note='表达层级位置。子项是链接，URL 必须走 appPath（gate:urls 会挡硬编码路径）。'>
        <Row label='三段 / 两段'>
          <Breadcrumbs>
            <a href={roomHref('14-home')}>首页</a>
            <a href={roomHref('12-topic')}>自制战役</a>
            <span>第三章讨论</span>
          </Breadcrumbs>
          <Breadcrumbs>
            <a href={roomHref('14-home')}>首页</a>
            <span>搜索</span>
          </Breadcrumbs>
        </Row>
      </Card>

      <Card name='分页 Pager' note='我们的 AppPager：中文文案 + 总数 + 每页条数（默认 20/50/100）。下面同时放 Ring 原生做对照——不封装就是英文。'>
        <Row label='我们的 AppPager（中文）'>
          <AppPager total={1284} currentPage={page} pageSize={size} onPageChange={setPage} onPageSizeChange={setSize} />
        </Row>
        <Row label='Ring 原生 Pager（英文，作为对照）' hint='这就是不封装的后果'>
          <PagerRing total={1284} currentPage={page} pageSize={size} onPageChange={setPage} onPageSizeChange={setSize} />
        </Row>
        <Row label='当前状态'>
          <span className='text-[12px] text-muted-foreground'>第 {page} 页，每页 {size} 条</span>
        </Row>
      </Card>

      <Card name='容器 Panel / Island' note='内容的分组容器。Panel 用于列表段落，Island 用于独立卡片块；不要自己拼边框阴影。'>
        <Row label='Panel（无内边距）/ Island（可调窄）'>
          <div className='w-full max-w-md'>
            <Panel>
              <div className='p-3 text-[13px] text-foreground'>Panel 里的一段内容</div>
            </Panel>
          </div>
          <div className='w-full max-w-md'>
            <Island>
              <div className='p-3 text-[13px] text-foreground'>Island：独立卡片块</div>
            </Island>
          </div>
        </Row>
      </Card>

      <Card name='待补' note='这一类里复杂的那几个，需要单独一轮（不能猜签名）。'>
        <Row label='未做' hint='不做出来不许进业务页面'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>Table / SimpleTable（列配置复杂）</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>List（数据源机器）</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>ContentLayout + Sidebar（真实布局）</span>
        </Row>
      </Card>
    </div>
  );
}
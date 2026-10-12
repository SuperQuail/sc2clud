import { useState } from 'react';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import PagerRing from '@jetbrains/ring-ui-built/components/pager/pager';
import { AppPager } from '@/ui/pager';
import Panel from '@jetbrains/ring-ui-built/components/panel/panel';
// 注意：Tabs 是**命名导出**（没有 default），Tab 也一样
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { appPath } from '@/lib/url';
import { Card, Row } from '@/devroom/kit';

// DevRoom 03 · 导航与结构（README 规划的第三页）
// 这一类控件共享「位置感」：我在哪、能去哪、内容装在什么容器里。
// 全部 Ring 原生：**Tab 没有 selected 属性**，选中态由 Tabs 的 selected + onSelect 管。
export default function NavigationPage() {
  const [tab, setTab] = useState('topics');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);

  return (
    <div className='flex flex-col gap-4'>
      <Card name='标签页 Tabs' note='切换同一页面内的视图，不换 URL（切 URL 用链接）。选中态在 Tabs 上，Tab 只给 id/title。'>
        <Row label='选中 / 禁用 / 带计数' hint='selected + onSelect 都由 Tabs 管'>
          <div className='w-full'>
            <Tabs selected={tab} onSelect={(id: string) => setTab(String(id))}>
              <Tab id='topics' title='主题' />
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

      <Card name='面包屑 Breadcrumbs' note='表达层级位置。子项是链接，**URL 必须走 appPath**（gate:urls 会挡硬编码路径）。'>
        <Row label='三段 / 两段'>
          <Breadcrumbs>
            <a href={appPath('')}>首页</a>
            <a href={appPath('b/campaign')}>自制战役</a>
            <span>第三章讨论</span>
          </Breadcrumbs>
          <Breadcrumbs>
            <a href={appPath('')}>首页</a>
            <span>搜索</span>
          </Breadcrumbs>
        </Row>
      </Card>

      <Card name='分页 Pager' note='**我们的 AppPager**：中文文案 + 总数 + 每页条数（默认 20/50/100）。下面同时放 Ring 原生做对照——**不封装就是英文**。'>
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

      <Card name='容器 Panel / Island' note='内容的分组容器。Panel 用于列表段落，Island 用于独立卡片块；**不要自己拼边框阴影**。'>
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

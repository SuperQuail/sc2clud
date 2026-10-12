import Button from '@jetbrains/ring-ui-built/components/button/button';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { useEffect, useState } from 'react';
import { Flame, MessageSquare, Pin } from 'lucide-react';
import { appPath, assetUrl } from '@/lib/url';
import { Card, Row } from '@/devroom/kit';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserAvatar } from '@/ui/user/avatar';
import { AppPager } from '@/ui/pager';
import { CommentBody } from '@/ui/comment/comment-body';

// DevRoom 00 · 我们的样板间
// **这一页的用途**：拿已登记的控件搭出一个真实页面，作为之后所有页面的**美术风格基准**——
// 密度、字号、间距、边框、颜色怎么用，看这一页就够了。
// 规矩：不出现任何未登记的控件、不写死路径、颜色只走令牌。
const TOPICS = [
  { id: 1, title: '第三章「余烬」发布公告与更新日志', tags: [{ t: '置顶', type: TagType.MAIN }, { t: '公告', type: TagType.DEFAULT }], author: { nickname: '唐天', role: { key: 'admin', name: '管理员' }, title: { name: '执政官', color: '#2563eb' } }, replies: 128, views: 4203, last: '3 分钟前', pinned: true },
  { id: 2, title: '虫族第 11 关怎么过？菌毯铺得太快了', tags: [{ t: '求助', type: TagType.WARNING }], author: { nickname: '某小X' }, replies: 42, views: 890, last: '12 分钟前' },
  { id: 3, title: '我做的第一章素材包（含 18 张地图）', tags: [{ t: '资源', type: TagType.SUCCESS }], author: { nickname: '林诗', role: { key: 'creator', name: '认证创作者' }, title: { name: '精华作者', color: '#7c3aed' } }, replies: 236, views: 12044, last: '1 小时前', hot: true },
  { id: 4, title: '关于平衡性的几点想法，欢迎讨论', tags: [{ t: '讨论', type: TagType.PURPLE }], author: { nickname: '新来的' }, replies: 18, views: 402, last: '2 小时前' },
  { id: 5, title: '存档兼容性说明（装过第二章的直接进游戏）', tags: [{ t: '公告', type: TagType.DEFAULT }], author: { nickname: '唐天', role: { key: 'admin', name: '管理员' }, title: { name: '执政官', color: '#2563eb' } }, replies: 64, views: 3310, last: '昨天' },
];

const ACTIVE = ['唐天', '林诗', '某小X', '新来的', '夜航星', '黑曜石'];

export default function ShowroomPage() {
  const [tab, setTab] = useState('home');
  const [page, setPage] = useState(1);
  const [pagerSize, setPagerSize] = useState(20);
  // 主题跟随系统时，让这一页的截图为浅色：出图脚本会带 theme 参数
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className='flex flex-col gap-4'>
      {/* 指南：heading 要有层级。视觉上不显示，但结构上必须有 h1 */}
      <h1 className='sr-only'>自制战役 · 主题列表</h1>

      {/* ── 顶栏：这是全站骨架，后续页面都照这个来 ── */}
      <Island withoutPaddings>
        <div className='flex flex-wrap items-center gap-4 px-4 py-2.5'>
          <img src={assetUrl('sc2-logo.png')} alt='' width={28} height={28} className='rounded' />
          <Tabs selected={tab} onSelect={(id: string) => setTab(String(id))}>
            <Tab id='home' title='首页' />
            <Tab id='boards' title='分区' />
            <Tab id='essence' title='精华' />
            <Tab id='rank' title='排行' />
          </Tabs>
          <div className='ml-auto flex min-w-56 max-w-72 flex-1 items-center gap-2'>
            <Input aria-label='搜索主题、作者' name='q' autoComplete='off' spellCheck={false} placeholder='搜索主题、作者…' />
          </div>
          <Button>发帖</Button>
          <span className='flex items-center gap-2'>
            <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='sm' />
            <Username nickname='唐天' role={{ key: 'admin', name: '管理员' }} badge='corner' />
          </span>
        </div>
      </Island>

      {/* 放进 flex 行容器：Breadcrumbs 的子项在块级上下文里会各占一行（踩过） */}
      <div className='flex items-center'>
        <Breadcrumbs>
          <a href={appPath('')}>首页</a>
          <a href={appPath('b/campaign')}>自制战役</a>
          <span>第三章讨论</span>
        </Breadcrumbs>
      </div>

      <div className='grid gap-4 lg:grid-cols-[1fr_18rem]'>
        {/* ── 主列：主题列表 ── */}
        <div className='flex flex-col gap-3'>
          <Island withoutPaddings>
            <div className='flex items-center gap-2 border-b border-border px-4 py-2.5'>
              <Pin aria-hidden className='size-4 text-muted-foreground' />
              <span className='text-[13px] font-medium text-foreground'>置顶</span>
            </div>
            {TOPICS.filter((t) => t.pinned).map((t) => (
              <TopicRow key={t.id} topic={t} />
            ))}
          </Island>

          <Island withoutPaddings>
            <div className='flex items-center gap-2 border-b border-border px-4 py-2.5'>
              <Flame aria-hidden className='size-4 text-muted-foreground' />
              <span className='text-[13px] font-medium text-foreground'>最新主题</span>
              <span className='ml-auto text-[12px] text-muted-foreground'>共 1,284 个主题</span>
            </div>
            {TOPICS.filter((t) => !t.pinned).map((t) => (
              <TopicRow key={t.id} topic={t} />
            ))}
          </Island>

          <div className='flex justify-center'>
            <AppPager total={1284} currentPage={page} pageSize={pagerSize} onPageChange={setPage} onPageSizeChange={setPagerSize} />
          </div>

          {/* 评论示意：展示折叠与提及（都是已验证的控件） */}
          <Island withoutPaddings>
            <div className='flex items-center gap-2 border-b border-border px-4 py-2.5'>
              <MessageSquare aria-hidden className='size-4 text-muted-foreground' />
              <span className='text-[13px] font-medium text-foreground'>最新回复</span>
            </div>
            <div className='flex flex-col gap-4 p-4'>
              <div className='flex gap-3'>
                <UserAvatar name='林诗' src={assetUrl('miyin-chibi-160.webp')} size='md' />
                <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
                  <span className='flex flex-wrap items-center gap-2'>
                    <Username nickname='林诗' strong />
                    <RoleBadge role={{ key: 'creator', name: '认证创作者' }} />
                    <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} />
                    <span className='text-[12px] text-muted-foreground'>2 小时前</span>
                  </span>
                  <CommentBody
                    collapsible
                    collapsedHeight={96}
                    className='text-[15px] leading-[1.7] text-foreground'
                    body={
                      '<p>第三章的节奏比前两章紧凑很多，尤其是第 11 关的菌毯推进。建议带两个工程车随时补防空，另外 ' +
                      '<a href="' + appPath('u/58') + '" data-mention="58">@某小X</a>' +
                      ' 那条帖子里说的分矿时机是对的。</p>' +
                      '<p>补充一点：如果你在前面没升级防空，中期会很难受，最好在 8 分钟前把两个导弹塔补上。我第一次就是晚了，结果第 12 关开头直接被打穿，只能重开。</p>' +
                      '<p>另外资源点建议提前开，尤其是左下角那个高能瓦斯——第三章之后 AI 会来抢，晚两分钟中期就卡科技。</p>' +
                      '<p>最后，如果只想快速过关，可以用两个运输机空投绕过中路，但要留一队守家，否则后方会被绕。</p>'
                    }
                  />
                </div>
              </div>
            </div>
          </Island>
        </div>

        {/* ── 右栏：分区信息 ── */}
        <div className='flex flex-col gap-3'>
          <Island withoutPaddings>
            <div className='flex flex-col gap-3 p-4'>
              <span className='text-[13px] font-semibold text-foreground'>自制战役</span>
              <p className='text-[12px] leading-relaxed text-muted-foreground'>
                玩家自制战役与地图的发布、讨论与求助。发帖前请先搜索是否已有同类主题。
              </p>
              <div className='flex items-center justify-between text-[12px] text-muted-foreground'>
                <span>本月发布目标</span>
                <span className='tabular-nums'>168 / 200</span>
              </div>
              <ProgressBar value={168} max={200} />
              <div className='flex items-center gap-2'>
                <Button>关注分区</Button>
                <Button>发帖</Button>
              </div>
            </div>
          </Island>

          <Island withoutPaddings>
            <div className='flex flex-col gap-3 p-4'>
              <span className='text-[13px] font-semibold text-foreground'>当前在线</span>
              {/* 用户头像一律用 UserAvatar（Ring 的 Avatar 是给项目/组织用的色块首字，不是用户头像） */}
              <span className='flex items-center'>
                {ACTIVE.map((n, i) => (
                  <span key={n} className={i === 0 ? '' : '-ml-2'} title={n}>
                    <UserAvatar name={n} size='sm' className='ring-2 ring-background' />
                  </span>
                ))}
              </span>
              <span className='text-[12px] text-muted-foreground'>共 42 人在线 · 6 位作者</span>
            </div>
          </Island>

          <Island withoutPaddings>
            <div className='flex flex-col gap-2 p-4'>
              <span className='text-[13px] font-semibold text-foreground'>版规</span>
              <ol className='ml-4 list-decimal text-[12px] leading-relaxed text-muted-foreground'>
                <li>标题写清章节与问题，别写「急」。</li>
                <li>资源帖请注明是否允许转载。</li>
                <li>剧透内容打上「剧透」标签。</li>
              </ol>
            </div>
          </Island>
        </div>
      </div>

      <Card
        name='这一页用到的东西（风格基准）'
        note='全部来自已登记控件；后续页面照这一页的密度与用法来，不要各自发明。'
      >
        <Row label='骨架 / 导航 / 展示 / 输入 / 分页'>
          <span className='text-[12px] text-muted-foreground'>
            Island · Panel · Tabs · Breadcrumbs · Tag · Avatar · AvatarStack · ProgressBar · Input · Button ·
            AppPager（中文分页）· Username / RoleBadge / TitleBadge / **UserAvatar**（用户头像只用我们的）· CommentBody（含折叠）
            {mounted ? '' : ''}
          </span>
        </Row>
        <Row label='风格约定' hint='看这一页就能抄'>
          <span className='flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
            <Tag tagType={TagType.MAIN}>主色只用于主操作</Tag>
            <Tag>正文 15px / 次要 12–13px</Tag>
            <Tag>卡片用 Island，内边距 p-4</Tag>
            <Tag>分区之间 gap-3 / gap-4</Tag>
          </span>
        </Row>
      </Card>
    </div>
  );
}

/** 主题列表的一行。**这是全站最常用的排布**：标题 + 标签 + 作者行 + 统计 + 最后回复。 */
function TopicRow({
  topic,
}: {
  topic: {
    id: number;
    title: string;
    tags: Array<{ t: string; type: TagType }>;
    author: { nickname: string; role?: { key: string; name: string } | null; title?: { name: string; color?: string } | null };
    replies: number;
    views: number;
    last: string;
    hot?: boolean;
  };
}) {
  return (
    <div className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/40'>
      <UserAvatar name={topic.author.nickname} size='sm' />
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <span className='flex flex-wrap items-center gap-2'>
          {topic.tags.map((tag) => (
            <Tag key={tag.t} tagType={tag.type}>
              {tag.t}
            </Tag>
          ))}
          <a
            href={appPath('t/' + topic.id)}
            className='min-w-0 truncate rounded-[3px] text-[15px] font-medium text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            {topic.title}
          </a>
        </span>
        <span className='flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
          <Username nickname={topic.author.nickname} size='sm' />
          {topic.author.role ? <RoleBadge role={topic.author.role} /> : null}
          {topic.author.title ? <TitleBadge title={topic.author.title} size='sm' /> : null}
          <span>· {topic.replies} 回复 · {topic.views} 浏览</span>
          <span className='ml-auto'>{topic.last}</span>
        </span>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { FolderOpen, Flag, ImagePlus, MessageSquare, Star } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { TitleBadge } from '@/ui/user/title-badge';
import { RoleBadge } from '@/ui/user/role-badge';
import { IconTabs, type IconTabItem } from '@/ui/nav/icon-tabs';
import { TopicRow } from '@/ui/topic/topic-row';
import { ProfileHero, type ProfileStat } from '@/devroom/pages/11-profile/profile-hero';
import { SponsorCard } from '@/devroom/pages/11-profile/sponsor-card';
import { assetUrl, appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { fetchUserProfile, fetchUserTopics } from '@/lib/api/user';
import { formatTime } from '@/lib/format';
import { toCardTopic } from './_parts/mappers';
import { Empty, ErrorState, Loading } from './_parts/state';
import { ReportPanel } from './_parts/report-panel';
import { PAGE_LIMIT } from '@/lib/api/paging';
import { ListEnd } from '@/devroom/pages/14-home/states';

// 个人主页（契约：GET /users/{handle} 聚合 + GET /users/{handle}/topics 游标分页）。
//
// **字段名照抄后端 user.Profile（forum/internal/user/service.go:52-68）：它是平铺的** ——
// topic_count / like_received / level 都在顶层，没有 stats 子对象（2026-10-14 之前这里读 u.stats，
// 于是线上三个统计全渲染成「—」）。**接口也没有 is_self**：「是不是本人」由这里比会话 handle 得出。
//
// 版式走 DevRoom 11-profile 的房子件：ProfileHero + IconTabs + 右栏（徽章 / 赞助卡），
// **同一份实现**，房间与产品共用，不是抄一份。
//
// 标签页（?tab=）两档，**口径是后端有没有端点**，不是设计稿画了几个：
//   · 帖子（默认）—— GET /users/{handle}/topics，一直在用；
//   · 收藏 —— 只有自己的主页出现（GET /me/bookmarks；后端没有 /users/{handle}/bookmarks，看别人的收藏做不出来）。
// **不画「回复」「赞过」**：设计稿有，但没有任何端点能给别人的回复/点赞列表（§21.2 里只有 topics 与 me/bookmarks），
// 画出来只能是一档空列表，用户会以为「TA 没回过帖」。设置也**不做成标签**：它已经是独立路由 /settings，
// 埋进个人主页会让「怎么改密码」多一条只在本人主页才存在的路。
export function ProfilePage() {
  const { handle = '' } = useParams();
  const session = useSession();
  const [reporting, setReporting] = useState(false);
  // 标签页进 URL（与首页的 board / sort / view 同一条规则）：可分享、可后退、刷新不丢。
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'starred' ? 'starred' : 'posts';

  const profile = useQuery({
    queryKey: qk.profile(handle),
    queryFn: ({ signal }) => fetchUserProfile(handle, signal),
    enabled: handle !== '',
    staleTime: 60_000,
  });
  // **不要按页签禁用它**：react-query v5 里被禁用的查询 `isPending` 恒为 true，
  // 而「概览」页签也画「最近发布」—— 于是那个加载态会一直转（用户实测「无限加载帖子」）。
  const topics = useInfiniteQuery({
    queryKey: qk.userTopics(handle),
    queryFn: ({ pageParam, signal }) => fetchUserTopics(handle, { cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    enabled: handle !== '',
    getNextPageParam: (last) => last.next,
  });

  if (profile.isPending) return <Loading what='个人主页' />;
  if (profile.isError) {
    return <ErrorState what='个人主页' error={profile.error} onRetry={() => void profile.refetch()} />;
  }

  const u = profile.data;
  const isSelf = session.session?.handle != null && session.session.handle === u.handle;
  const items = topics.data?.pages.flatMap((p) => p.items) ?? [];
  // 设计稿的四个统计里只有两个后端有：帖子 / 获赞；另加一个真实存在的等级。
  // **不画「回复」「关注者」** —— 后端没有这两个数，写上去只能显示「—」。
  const stats: ProfileStat[] = [
    { value: String(u.topic_count), label: '帖子' },
    { value: String(u.like_received), label: '获赞' },
    { value: String(u.level), label: '等级' },
  ];
  // 标签组：计数用后端真有的两个数（profile.topic_count；收藏那一档没有计数端点，所以不带数）
  const tabs: IconTabItem[] = [
    { key: 'posts', label: '帖子', icon: <FolderOpen aria-hidden className='size-5' />, count: u.topic_count },
    ...(isSelf
      ? [{ key: 'starred', label: '收藏', icon: <Star aria-hidden className='size-5' /> }]
      : []),
  ];
  const activeTab: 'posts' | 'starred' = isSelf && tab === 'starred' ? 'starred' : 'posts';
  // 有头衔或角色才画那一格（都没有就不画空盒子）。**角色**接口不给：user.Profile 里没有 role 字段，
  // 所以真站点上这一格通常只有头衔；会话里带了 role 时（本人）才多一枚角色徽标。
  const badges = (
    <span className='flex flex-wrap items-center gap-2'>
      {u.title ? <TitleBadge title={u.title} size='sm' /> : null}
      {isSelf && session.session?.role ? <RoleBadge role={session.session.role} /> : null}
    </span>
  );

  return (
    <div className='flex flex-col gap-4'>
      <ProfileHero
        // 用户封面后端还没有端点（没有 users.cover 列），用站内素材；换成真封面要等 media 那条链路。
        cover={assetUrl('starcraft/sc2-battle.webp')}
        nickname={u.nickname}
        handle={u.handle}
        joined={u.joined_at ? joinedText(u.joined_at) : undefined}
        bio={u.bio || undefined}
        avatar={u.avatar || null}
        title={u.title}
        stats={stats}
        // 设计稿（11-profile）的 hero 右上角是「更换头像 + 更换封面」一对。真站点**只有头像这一半**：
        // POST/DELETE /me/avatar 都在，落点是设置页里那块真上传控件（压缩 → multipart → 刷会话）。
        // 封面**没有任何后端承载**（users 没有封面列、也没有端点），所以这里不画那颗按钮 ——
        // 画一颗点了没反应的假入口比缺一个入口更糟（见回报的缺口清单）。
        topActions={
          isSelf ? (
            <span className='rounded-md bg-background/85 backdrop-blur-sm'>
              <Button
                data-testid='change-avatar'
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(ImagePlus)}
                href={appPath('settings')}
              >
                更换头像
              </Button>
            </span>
          ) : undefined
        }
        actions={
          <>
            {isSelf ? (
              <Button inline={false} height={ControlsHeight.S} href={appPath('settings')}>
                账号设置
              </Button>
            ) : (
              <>
                {/* 关注**没有端点**（PUT /users/{handle}/block 是拉黑，不是关注），所以不画「关注」——
                    一颗点了没反应的按钮比没有这颗按钮更糟。 */}
                <Button
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(MessageSquare)}
                  href={appPath('messages/' + encodeURIComponent(u.handle))}
                >
                  发私信
                </Button>
                {session.isLoggedIn ? (
                  <Button
                    data-testid='profile-report'
                    inline={false}
                    height={ControlsHeight.S}
                    icon={icon16(Flag)}
                    active={reporting}
                    onClick={() => setReporting((v) => !v)}
                  >
                    举报
                  </Button>
                ) : null}
              </>
            )}
          </>
        }
      />

      {reporting ? (
        <ReportPanel
          targetType='user'
          targetId={u.id}
          targetLabel={'用户「' + u.nickname + '」'}
          onClose={() => setReporting(false)}
        />
      ) : null}

      {/* 与 DevRoom 11-profile 同一处：hero 下面是大号标签组，再往下是「内容 + 右栏」两列。
          右栏只在 ≥lg 展开：窄屏先看内容，右栏的徽章与赞助卡掉到最下面（与房间同一套断点）。 */}
      <IconTabs
        items={tabs}
        value={activeTab}
        onChange={(key) => setParams(key === 'starred' ? { tab: 'starred' } : {}, { replace: true })}
        ariaLabel='个人主页分区'
      />

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]'>
        <div className='flex min-w-0 flex-col gap-4'>
      {activeTab === 'starred' ? (
        <section className='flex flex-col gap-2'>
          <h2 className='m-0 text-[15px] font-semibold text-foreground'>我的收藏</h2>
          {/* 收藏列表本身在 /me（那里已经有 GET /me/bookmarks 的渲染），这里不复制第二份列表。 */}
          <Empty
            title='收藏在自己的「我的」页里'
            hint='收藏只对自己可见，所以它不挂在公开的个人主页数据流里；点下面那颗按钮去那边看。'
            action={
              <Button inline={false} height={ControlsHeight.S} href={appPath('me')}>
                去「我的」看收藏
              </Button>
            }
          />
        </section>
      ) : (
      <section className='flex flex-col gap-2'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>{isSelf ? '我的帖子' : 'TA 的帖子'}</h2>
        {topics.isPending ? (
          <Loading what='帖子' className='py-8' />
        ) : topics.isError ? (
          <ErrorState what='帖子' error={topics.error} onRetry={() => void topics.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            title={isSelf ? '你还没有发布过帖子' : 'TA 还没有发布过帖子'}
            hint='帖子按发布时间倒序；游标分页，不是页码。'
            action={isSelf ? <Button href={appPath('new')}>去发第一帖</Button> : undefined}
          />
        ) : (
          <>
            <Island withoutPaddings>
              {items.map((t) => {
                const c = toCardTopic(t);
                return (
                  <TopicRow
                    key={c.id}
                    topic={{
                      id: c.id,
                      title: c.title,
                      tags: [{ text: c.board.name }],
                      author: c.author,
                      replies: c.reply_count,
                      views: c.view_count,
                      lastReplyAt: formatTime(c.last_reply_at),
                      href: appPath('t/' + encodeURIComponent(c.id)),
                    }}
                  />
                );
              })}
            </Island>
            {topics.hasNextPage ? (
              <div className='flex flex-col items-center gap-1.5'>
                <Button loader={topics.isFetchingNextPage} onClick={() => void topics.fetchNextPage()}>
                  {topics.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
                <span className='text-[11px] text-muted-foreground'>
                  每页 {PAGE_LIMIT} 条 · 按游标翻页（不是页码）
                </span>
              </div>
            ) : (
              <ListEnd total={items.length} />
            )}
          </>
        )}
      </section>
      )}

      {/* 自己的账号现在不能发帖（未激活 / 没有 topic.create）时要说清原因：
          否则用户看到的是「什么都没有」，而真正的原因在账号状态里。 */}
      {isSelf && !can(session.session, 'topic.create') ? (
        <p className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground'>
          你的账号现在不能发帖（未激活或没有 topic.create 权限）。账号状态在{' '}
          <Link to={routePath('settings')} className='underline'>
            账号设置
          </Link>
          。
        </p>
      ) : null}
        </div>

        {/* 右栏：徽章 → 赞助 → 关注的人。
            赞助放在徽章下面一格：它是这个页面唯一的转化点（读完之后「想支持一下」的那一秒），
            但**这一版还没接**（后端没有 users 的收款码列、也没有 GET /users/{handle}/channels 与 POST /rewards），
            所以用 disableReason 标注清楚，不留一颗点了没反应的按钮。
            「关注的人」**整格不做**：本产品没有关注关系（拍板 §8.3），后端也没有这个端点。 */}
        <aside className='flex flex-col gap-3'>
          {u.title || (isSelf && session.session?.role) ? (
            <Island withoutPaddings>
              <div className='flex flex-col gap-3 p-4'>
                <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>徽章</span>
                {badges}
              </div>
            </Island>
          ) : null}
          <SponsorCard
            isSelf={isSelf}
            channels={[]}
            disableReason={
              isSelf
                ? '收款码还没有后端承载（users 没有这一列、也没有写入端点），所以这一颗先不给点。'
                : undefined
            }
          />
        </aside>
      </div>
    </div>
  );
}

/** 「2024 年 3 月加入」：接口给的是 RFC3339，页面上要的是年月。 */
function joinedText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(d) + ' 加入';
}

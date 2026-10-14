import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Flag, ImagePlus, MessageSquare } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { TopicRow } from '@/ui/topic/topic-row';
import { ProfileHero, type ProfileStat } from '@/devroom/pages/11-profile/profile-hero';
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
// 版式走 DevRoom 11-profile 的房子件 ProfileHero（**同一份实现**，房间与产品共用，不是抄一份）。
// 设计稿里的标签页（回复 / 收藏 / 赞过 / 设置）与右栏（赞助卡 / 关注的人）这一版**没做**：
//   回复、收藏、赞过对**别人**没有端点（/me/bookmarks 只给自己）；设置已经有独立路由 /settings；
//   赞助卡是演示件（二维码画的是图标、申报要 POST /rewards 的金额与单号）—— 见回报的缺口清单，
//   不画点了没反应的入口，也不在真站点上放假 UI。
export function ProfilePage() {
  const { handle = '' } = useParams();
  const session = useSession();
  const [reporting, setReporting] = useState(false);

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
  );
}

/** 「2024 年 3 月加入」：接口给的是 RFC3339，页面上要的是年月。 */
function joinedText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(d) + ' 加入';
}

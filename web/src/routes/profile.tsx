import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { FolderOpen, Star } from 'lucide-react';
import { TitleBadge } from '@/ui/user/title-badge';
import { RoleBadge } from '@/ui/user/role-badge';
import { IconTabs, type IconTabItem } from '@/ui/nav/icon-tabs';
import { TopicRow } from '@/ui/topic/topic-row';
import { ProfileHero, type ProfileStat } from '@/devroom/pages/11-profile/profile-hero';
import { CoverPicker, type CoverPickerHandle } from '@/ui/cover-picker';
import { ImageUploader } from '@/ui/rich/image-uploader';
import { SponsorCard } from '@/devroom/pages/11-profile/sponsor-card';
import { assetUrl, appPath, imagePath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { clearCover, fetchUserProfile, fetchUserTopics, uploadAvatar, uploadCover } from '@/lib/api/user';
import { equipTitle, fetchUserTitles } from '@/lib/api/title';
import { fetchUserFollowers } from '@/lib/api/follow';
import { createDonation, fetchDonationSettings, fetchUserChannels } from '@/lib/api/rewards';
import { useMyPaymentChannels } from '@/devroom/pages/11-profile/payment-channels-hook';
import { formatCents, formatTime } from '@/lib/format';
import { isApiError } from '@/lib/api/errors';
import { toCardTopic } from './_parts/mappers';
import { Empty, ErrorState, Loading } from './_parts/state';
import { ReportPanel } from './_parts/report-panel';
import { ProfileActions } from './_parts/profile-actions';
import { UserFollowList } from './_parts/follow-lists';
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
  const queryClient = useQueryClient();
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

  // 是不是本人：接口**没有 is_self**（user.Profile 平铺，见文件头），由会话 handle 与路径比出来。
  // 必须在下面那几个 useQuery 之前算：它们的 enabled 要用它。
  const isSelf = session.session?.handle != null && session.session.handle === handle;

  // 收款码（L1）：GET /users/{handle}/channels —— 作者关掉「展示收款码」时后端回**空数组**（不是 null）。
  // 看自己时那一格是「设置我的收款码」入口，不依赖这个请求，所以本人态干脆不发。
  const channels = useQuery({
    queryKey: qk.userChannels(handle),
    queryFn: ({ signal }) => fetchUserChannels(handle, signal),
    enabled: handle !== '' && !isSelf,
  });
  // 提示文案只在看自己时取得到（GET /me/donation-settings）；别人的文案后端**没有公开读端点**，
  // 所以看别人时不编 —— 编一句「打赏是自愿的」冒充作者的话，比不显示更糟。
  const donationSettings = useQuery({
    queryKey: qk.donationSettings(),
    queryFn: ({ signal }) => fetchDonationSettings(signal),
    enabled: isSelf,
  });
  // 头衔（D18）：本人的头衔可点开下拉（佩戴 / 不佩戴）。清单来自 GET /users/{handle}/titles
  // ——**只有本人**才发这个请求：下拉只对本人有意义，别人的主页那一枚是纯展示（hero 没拿到 options 就不包触发器）。
  const titles = useQuery({
    queryKey: qk.userTitles(handle),
    queryFn: ({ signal }) => fetchUserTitles(handle, signal),
    enabled: isSelf,
  });
  // 选完即调 PUT /me/title（body 是 { title_id }，null = 卸下），成功**两处都失效**：
  // hero 上那枚徽标读的是 user.Profile.title，下拉里「当前佩戴」读的是 equipped_id —— 是两个端点给的两份。
  const equip = useMutation({
    mutationFn: (id: string | null) => equipTitle(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profile(handle) });
      void queryClient.invalidateQueries({ queryKey: qk.userTitles(handle) });
    },
  });

  // 封面（拍板 08 第二轮「壁纸替换」）：POST/DELETE /me/cover 落 users.cover_hash（0030）。
  // **就地换**：hero 右上那颗「更换封面」打开这一格里的上传控件（不再往设置页跳），
  // 选完即传，成功后 invalidate 这一页的资料查询 —— 新封面从服务端回来才算数。
  // 弹层挂在页面根部、句柄给 hero 那颗按钮用（与 DevRoom 的 avatarApi 同一用法）
  const coverApi = useRef<CoverPickerHandle | null>(null);
  const coverSave = useMutation({
    mutationFn: (file: Blob) => uploadCover(file),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.profile(handle) }),
  });
  const coverClear = useMutation({
    mutationFn: () => clearCover(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.profile(handle) }),
  });
  // 头像就地换（2026-10-14 用户要求）：hero 上的头像自己就是入口 —— 悬停出「替换图像」，
  // 点它打开文件选择。上传器挂在页根、**headless**（只提供 file input 与句柄），
  // 与封面那套一模一样：选完即传，成功后 invalidate 资料查询。
  const avatarApi = useRef<{ open: () => void } | null>(null);
  const avatarSave = useMutation({
    mutationFn: (file: Blob) => uploadAvatar(file),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.profile(handle) }),
  });
  // 本人侧的收款码管理（D22 弹层用）：与设置页那一格同一个 hook、同一份客户端代码。
  // 看别人时不发这些请求（那里那一格是打赏入口，不是管理入口）。
  const donateChannels = useMyPaymentChannels(isSelf);
  // 打赏申报（POST /rewards）：**是登记，不是付款** —— 钱是扫码直接给作者的，站点不经手资金。
  const donate = useMutation({
    mutationFn: (v: { channelId: string; amountCents: number }) =>
      createDonation({ to_handle: handle, amount_cents: v.amountCents, channel_id: v.channelId }),
  });

  if (profile.isPending) return <Loading what='个人主页' />;
  if (profile.isError) {
    return <ErrorState what='个人主页' error={profile.error} onRetry={() => void profile.refetch()} />;
  }

  const u = profile.data;
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
        // 封面：本人设过就用 users.cover_hash 那张，没设过回落站内素材（与头像回落默认池同一口径）。
        // 2026-10-14 之前这里恒为站内素材 —— 因为库里没有封面列、media 也没有封面通道（拍板 08 第二轮补齐）。
        // D58（生产裂图）：cover 是后端下发的 /img/<hash>，imagePath 原样放行；此前误过 assetUrl
        // （前置 art/），浏览器实际请求 /art/img/<hash> → SPA 回落 index.html → <img> 拿到 HTML 裂图。
        cover={u.cover ? imagePath(u.cover) : assetUrl('starcraft/sc2-battle.webp')}
        hasCover={u.cover !== ''}
        // 本人可点；看别人主页时画一颗明确禁用的（禁用 + title 说清原因，而不是「点了没反应」）
        onCoverPick={isSelf ? () => coverApi.current?.open() : null}
        nickname={u.nickname}
        handle={u.handle}
        joined={u.joined_at ? joinedText(u.joined_at) : undefined}
        bio={u.bio || undefined}
        avatar={u.avatar || null}
        title={u.title}
        // 本人的头衔可点（D18）：下拉是「我持有的 + 不佩戴」；看别人时三样都不传 = 纯展示
        titleOptions={isSelf ? titles.data?.items : undefined}
        equippedTitleId={titles.data?.equipped_id}
        onTitlePick={isSelf ? (id) => equip.mutate(id) : undefined}
        stats={stats}
        // 头像的入口就是头像本身（AvatarPicker，2026-10-14）；封面那套走 onCoverPick 的弹层。
        // 不再有独立的「更换头像」按钮 —— 用户明确要求去掉。
        onAvatarPick={isSelf ? () => avatarApi.current?.open() : undefined}
        actions={
          <>
            {isSelf ? (
              <Button inline={false} height={ControlsHeight.S} href={appPath('settings')}>
                账号设置
              </Button>
            ) : (
              // 别人主页的动作条整块在 _parts/profile-actions（关注 / 私信 / 举报 / 拉黑）。
              // 抽出去的理由是行数：这一格是 profile.tsx 里最大的一块版式，而它已经贴着 500 行。
              <ProfileActions
                handle={handle}
                isLoggedIn={session.isLoggedIn}
                reporting={reporting}
                onToggleReport={() => setReporting((v) => !v)}
              />
            )}
          </>
        }
      />

      {/* 头像的上传器：只有 file input 与句柄（headless），界面入口是 hero 上那颗头像本身。
          「移除头像」放在设置页（那里有体积提示与配套说明），这里只做「换一张」。
          **只有本人主页才挂它**（看别人时连 file input + 裁剪框都不进 DOM）—— 与「别人主页不出现」同一条口径：
          入口不给只是不显示，DOM 里还留着一条上传通道 = 谁都可能把它摸出来。 */}
      {isSelf ? (
      <ImageUploader
        variant='avatar'
        headless
        // D23：头像自己就是入口，选完弹裁剪框选启用区域；裁完才发 POST /me/avatar。
        crop
        images={[]}
        onReady={(api) => { avatarApi.current = api; }}
        onError={() => {}}
        onChange={(next) => {
          const file = next[0]?.file;
          if (file) avatarSave.mutate(file);
        }}
      />
      ) : null}

      {/* 封面就地换：与 /settings 那处、后台分区屏那处**同一个弹层**（cover-picker.tsx）。
          hero 右上那颗「更换封面」不弹它自己的窗口 —— 它只是通过句柄代点这里，入口只有一处代码。 */}
      <CoverPicker
        cover={u.cover ? imagePath(u.cover) : null}
        pending={coverSave.isPending}
        // 入口是 hero 右上那颗（它通过句柄代点这里）——弹层自己不画按钮，否则同页两颗
        headless
        onPick={(file) => coverSave.mutate(file)}
        onReady={(api) => { coverApi.current = api; }}
        actions={u.cover ? (
          <Button inline={false} height={ControlsHeight.S} disabled={coverClear.isPending} onClick={() => coverClear.mutate()}>
            {coverClear.isPending ? '清除中…' : '清空封面'}
          </Button>
        ) : undefined}
      />
      {coverSave.isError || coverClear.isError ? (
        <p role='alert' className='m-0 text-[12px] text-destructive'>
          封面没能{coverClear.isError ? '清空' : '上传'}（{((coverClear.error ?? coverSave.error) as Error).message}）。
        </p>
      ) : null}

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

        {/* 右栏：徽章 → 赞助 → 关注者。
            赞助放在徽章下面一格：它是这个页面唯一的转化点（读完之后「想支持一下」的那一秒）。
            **2026-10-14（L1）接的是真数据**：这一格原先传 `channels={[]}` + `disableReason`
            （那时以为「后端没有收款码列、没有 GET /users/{handle}/channels、没有 POST /rewards」）——
            三样后端一直都有，缺的是前端客户端，所以那个逃生口连同它的注释一起删了。
            「关注的人」那句「本产品没有关注关系、后端也没有这个端点」在 L5 之后是**假话** ——
            端点在（GET /users/{handle}/followers，公开读），缺的只是调用方。 */}
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
            channels={channels.data ?? []}
            notice={isSelf ? donationSettings.data?.notice_text : undefined}
            // D22：本人那一颗「设置我的收款码」就地弹层（版面与设置页那一格是同一个 View），
            // 数据/动作来自 useMyPaymentChannels —— 与设置页共用一份客户端代码。
            editor={
              isSelf
                ? {
                    channels: donateChannels.channels,
                    pending: donateChannels.channelsPending,
                    error: donateChannels.channelsError,
                    settings: donateChannels.settings,
                    settingsPending: donateChannels.settingsPending,
                    settingsError: donateChannels.settingsError,
                    saveError: donateChannels.saveError,
                    notice: donateChannels.notice,
                    onNotice: donateChannels.setNotice,
                    onAdd: donateChannels.onAdd,
                    addPending: donateChannels.addPending,
                    addError: donateChannels.addError,
                    onDelete: donateChannels.onDelete,
                    removePending: donateChannels.removePending,
                    removeError: donateChannels.removeError,
                    onShowChannels: donateChannels.onShowChannels,
                  }
                : undefined
            }
            onDonate={(v: { channelId: string; amountCents: number }) => donate.mutate(v)}
            donationPending={donate.isPending}
            donationError={donate.isError ? (isApiError(donate.error) ? donate.error.message : '登记失败，请重试') : null}
            donationDone={
              donate.isSuccess
                ? '已登记一笔 ¥' + formatCents(donate.data.amount_cents) + ' 的申报，等作者核对到账后会计入 TA 的主页。可以在「个人设置 → 我的打赏记录」里撤回。'
                : null
            }
            loggedIn={session.isLoggedIn}
            loginHref={appPath('login?next=' + encodeURIComponent(routePath('u/' + handle)))}
          />
          {/* 关注者（GET /users/{handle}/followers）：**公开读**，游客也看得到「谁关注了 TA」。
              这一格只取第一页（20 条）；「共多少人」这里不显示 —— 那份真数（follow.State.follower_count）
              要登录才拿得到（GET /users/{handle}/follow 挂在 requireLogin 后面），
              拿不到就宁可不写，也不编一个数（总览里的三个统计同理）。 */}
          <Island withoutPaddings>
            <div data-testid='profile-followers' className='flex flex-col gap-2 p-4'>
              <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>关注者</span>
              <UserFollowList
                queryKey={qk.userFollowers(handle)}
                fetchPage={(signal) => fetchUserFollowers(handle, {}, signal)}
                emptyTitle='还没有人关注 TA'
                emptyHint='关注是公开的：谁关注了谁，这一格都看得到。'
              />
            </div>
          </Island>
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

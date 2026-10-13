import { lazy, Suspense, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Eye, Flag, Heart, MessageSquare, Pencil, Star, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
// 评论区按需加载：它是本页唯一引富文本编辑器（Lexical）的地方，而评论要等第二个请求才有内容
const CommentList = lazy(() => import('./_parts/comments'));
import { UserBadge } from '@/ui/user/user-badge';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { isApiError } from '@/lib/api/errors';
import {
  createPost,
  deleteTopic,
  fetchPosts,
  fetchTopic,
  setPostVote,
  setTopicBookmark,
  setTopicLike,
} from '@/lib/api/forum';
import { ReportPanel } from './_parts/report-panel';
import { TopicBody } from '@/devroom/pages/12-topic/topic-body';
import { TopicKindTag, TopicMark } from '@/devroom/pages/14-home/topic-parts';
import { formatTime } from '@/lib/format';
import { ComposeButton, PageHeader } from './_parts/layout';
import { ErrorState, Loading } from './_parts/state';
import { toComments } from './_parts/mappers';

// 帖子详情 + 回复（契约：GET /topics/{id}、GET /topics/{id}/posts、POST /topics/{id}/posts）�?// **公开首屏，不做代码分�?*（前端方�?§6：它是从搜索引擎直接落地的页面）�?// 正文渲染�?@/devroom/pages/12-topic/topic-body �?@/ui/markdown（全站唯一渲染 content_html 的地方）�?export function TopicPage() {
  const { topicId = '' } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const queryClient = useQueryClient();

  // 举报面板 / 删除确认 —�?同一时刻只开一个�?  // 盲测�?026-10-13）发现：这几个入口在前端**连函数都没有**，所以「发错了删不掉、看到违规没法举报」�?  const [panel, setPanel] = useState<'report' | 'delete' | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteTopic(topicId),
    onSuccess: () => {
      const slug = topic.data?.board.slug;
      // qk.topics �?*工厂函数**不是数组，所以这里用字面前缀失效（react-query 按前缀匹配）�?      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      void navigate(slug ? appPath('b/' + encodeURIComponent(slug)) : appPath(''), { replace: true });
    },
  });

  const topic = useQuery({
    queryKey: qk.topic(topicId),
    queryFn: ({ signal }) => fetchTopic(topicId, signal),
    enabled: topicId !== '',
    staleTime: 60_000,
  });
  const posts = useQuery({
    queryKey: qk.posts(topicId),
    queryFn: ({ signal }) => fetchPosts(topicId, {}, signal),
    staleTime: 30_000,
    enabled: topicId !== '',
  });

  const like = useMutation({
    mutationFn: (on: boolean) => setTopicLike(topicId, on),
    // 幂等开关才允许乐观更新（前端方�?§5.3）；失败�?useMutation 报错，界面回到服务端�?    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.topic(topicId) }),
  });
  const bookmark = useMutation({
    mutationFn: (on: boolean) => setTopicBookmark(topicId, on),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.topic(topicId) }),
  });
  const vote = useMutation({
    mutationFn: (v: { id: string; value: 1 | -1 | 0 }) => setPostVote(v.id, v.value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.posts(topicId) }),
  });
  const reply = useMutation({
    mutationFn: (v: { parentId: string | null; body: { json: string; html: string } }) =>
      createPost(topicId, { content_md: v.body.json, parent_id: v.parentId ?? undefined }),
    onSuccess: () => {
      // 回复成功后失效「回复列�?+ 主题」（主题�?reply_count 会变）——按影响面失效，不全�?invalidate
      void queryClient.invalidateQueries({ queryKey: qk.posts(topicId) });
      void queryClient.invalidateQueries({ queryKey: qk.topic(topicId) });
    },
  });

  if (topic.isPending) return <Loading what='帖子' />;
  if (topic.isError) {
    return (
      <ErrorState
        what={isApiError(topic.error) && topic.error.status === 404 ? '帖子' : '帖子详情'}
        error={topic.error}
        onRetry={() => void topic.refetch()}
      />
    );
  }

  const t = topic.data;
  const comments = toComments(posts.data?.items ?? []);
  const loggedIn = session.isLoggedIn;
  // 编辑/删除只给自己看：句柄相等即本人（服务端另�?post.update_own / post.delete_own 兜底）�?  const isAuthor = loggedIn && session.session?.handle === t.author.handle;
  const me = { nickname: session.session?.nickname ?? '', avatar: session.session?.avatar ?? null };

  return (
    <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_248px]'>
      <div className='flex min-w-0 flex-col gap-4'>
        <PageHeader
          backTo={appPath('b/' + encodeURIComponent(t.board.slug))}
          backLabel={t.board.name}
          title={t.title}
          description={
            <span className='flex flex-wrap items-center gap-2'>
              <span>发布�?{formatTime(t.created_at)}</span>
              <span>· {t.reply_count} 回复 · {t.like_count} �?· {t.view_count} 浏览</span>
            </span>
          }
          actions={<ComposeButton board={t.board.slug} />}
        />

        {t.locked ? (
          <p role='status' className='rounded-lg border border-border bg-muted px-3 py-2 text-[13px] text-foreground'>
            这篇帖子已被锁定，只能浏览�?          </p>
        ) : null}

        <article className='flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5'>
          <span className='flex flex-wrap items-center gap-2'>
            <TopicKindTag kind={t.kind} />
            <TopicMark pinned={t.pinned} featured={t.featured_at != null} />
          </span>

          <div className='border-b border-border pb-3'>
            <Link to={routePath('u/' + encodeURIComponent(t.author.handle))} className='w-fit rounded-[3px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'>
              <UserBadge user={t.author} size='md' showHandle />
            </Link>
          </div>

          <TopicBody contentHtml={t.content_html} />

          <div className='flex flex-wrap items-center gap-2 border-t border-border pt-3'>
            <Button
              data-testid='topic-like'
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(Heart)}
              primary={t.viewer?.liked}
              disabled={!loggedIn || like.isPending}
              title={loggedIn ? '点赞' : '登录后可点赞'}
              onClick={() => like.mutate(!t.viewer?.liked)}
            >
              {t.like_count}
            </Button>
            <Button
              data-testid='topic-bookmark'
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(Star)}
              primary={t.viewer?.bookmarked}
              disabled={!loggedIn || bookmark.isPending}
              title={loggedIn ? '收藏' : '登录后可收藏'}
              onClick={() => bookmark.mutate(!t.viewer?.bookmarked)}
            >
              {t.viewer?.bookmarked ? '已收�? : '收藏'}
            </Button>
            <span className='flex items-center gap-1 text-[12px] text-muted-foreground'>
              <MessageSquare aria-hidden className='size-3.5' />
              {t.reply_count}
            </span>
            {isAuthor ? (
              <>
                <Button
                  data-testid='topic-edit'
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(Pencil)}
                  title='编辑标题与正�?
                  onClick={() => void navigate(routePath('new?edit=' + encodeURIComponent(t.id)))}
                >
                  编辑
                </Button>
                <Button
                  data-testid='topic-delete'
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(Trash2)}
                  title='删除这篇帖子'
                  onClick={() => setPanel(panel === 'delete' ? null : 'delete')}
                >
                  删除
                </Button>
              </>
            ) : null}
            <Button
              data-testid='topic-report'
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(Flag)}
              disabled={!loggedIn}
              title={loggedIn ? '举报这篇帖子' : '登录后可举报'}
              onClick={() => setPanel(panel === 'report' ? null : 'report')}
            >
              举报
            </Button>
            <span className='flex items-center gap-1 text-[12px] text-muted-foreground'>
              <Eye aria-hidden className='size-3.5' />
              {t.view_count}
            </span>
            {like.isError ? <span className='text-[12px] text-destructive'>{errorText(like.error)}</span> : null}
          </div>
        </article>

        {panel === 'report' ? (
          <ReportPanel
            targetType='topic'
            targetId={t.id}
            targetLabel='这篇帖子'
            onClose={() => setPanel(null)}
          />
        ) : null}

        {panel === 'delete' ? (
          <section className='flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-3'>
            <span className='text-[13px] font-medium text-foreground'>删除这篇帖子�?/span>
            <span className='text-[12px] text-muted-foreground'>
              删除后帖子从列表里消失，正文会被标记为作者删除（平台侧仍留审计痕迹，不是物理删除）�?            </span>
            <span className='flex flex-wrap items-center gap-2'>
              <Button
                data-testid='topic-delete-confirm'
                primary
                inline={false}
                height={ControlsHeight.S}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                确认删除
              </Button>
              <Button inline={false} height={ControlsHeight.S} onClick={() => setPanel(null)}>
                取消
              </Button>
              {remove.isError ? (
                <span role='alert' className='text-[12px] text-destructive'>{errorText(remove.error)}</span>
              ) : null}
            </span>
          </section>
        ) : null}

        {posts.isPending ? (
          <Loading what='回复' className='py-8' />
        ) : posts.isError ? (
          <ErrorState what='回复' error={posts.error} onRetry={() => void posts.refetch()} />
        ) : loggedIn && can(session.session, 'topic.create') ? (
          <Suspense fallback={<Loading what='评论�? className='py-8' />}>
            <CommentList
              comments={comments}
              total={t.reply_count}
              me={me}
              onSubmit={(parentId, body) => reply.mutate({ parentId, body })}
              onVote={(id, value) => vote.mutate({ id, value })}
            />
          </Suspense>
        ) : (
          // 未登�?*不隐藏评论区**（前端方�?§5.4：显示入口，点了引导登录，别让人不知道功能存在）
          <section className='flex flex-col gap-3'>
            <h2 className='m-0 text-lg font-semibold text-foreground'>
              评论 <span className='tabular-nums'>{t.reply_count}</span>
            </h2>
            <p className='flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground'>
              {loggedIn ? '你的账号还不能发帖回复（未激活或没有 post.create 权限）�? : '登录后可以回复、点赞与收藏�?}
              <Button href={appPath('login?next=' + encodeURIComponent(routePath('t/' + t.id)))}>
                {loggedIn ? '查看账号状�? : '去登�?}
              </Button>
            </p>
            <Suspense fallback={<Loading what='评论�? className='py-8' />}>
              <CommentList comments={comments} total={t.reply_count} me={me} />
            </Suspense>
          </section>
        )}

        {reply.isError ? <ErrorState what='回复' error={reply.error} /> : null}
      </div>

      <aside className='flex flex-col gap-3'>
        <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
          <h2 className='m-0 text-[13px] font-semibold text-foreground'>关于作�?/h2>
          <UserBadge user={t.author} layout='stacked' size='lg' showHandle badges='below' />
          {t.author.bio ? <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>{t.author.bio}</p> : null}
          <p className='m-0 text-[12px] text-muted-foreground'>
            {t.author.level != null ? 'Lv.' + t.author.level + ' · ' : ''}
            {t.author.joined_at ? t.author.joined_at + ' 加入' : ''}
          </p>
          <Button inline={false} height={ControlsHeight.S} href={appPath('u/' + encodeURIComponent(t.author.handle))}>
            查看主页
          </Button>
        </section>

        <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
          <h2 className='m-0 text-[13px] font-semibold text-foreground'>分区</h2>
          <Link
            to={routePath('b/' + encodeURIComponent(t.board.slug))}
            className='w-fit rounded-[3px] text-[13px] text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            {t.board.name}
          </Link>
          <span className='text-[11px] text-muted-foreground'>同一分区的其它帖子都在这个链接下</span>
        </section>
      </aside>
    </div>
  );
}

function errorText(e: unknown): string {
  return isApiError(e) ? e.message : '操作失败，请重试';
}

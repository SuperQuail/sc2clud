import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Lock } from 'lucide-react';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { isApiError } from '@/lib/api/errors';
import { createTopic, fetchBoards, type TopicKind } from '@/lib/api/forum';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 发帖（契约：POST /topics，权限点 post.create；ACL 与禁言在 service 判 —— §21.2）。
// 正文与配图**是同一个控件**（@/ui/rich/markdown-editor，09-rich 已定：图片是正文节点，不是独立字段）；
// 所以这里只传标题、分区、类型与正文 Markdown。
//
// 已知契约缺口（写进回报的端点清单）：
//   ① topics.board_id 在 §21.2 里是 **id**，而全站句柄用的是 board.slug（/b/:slug、?board=）——
//      两者只能是一回事：前端统一送 slug，请后端在 dto 里按 slug 接受（或告知 id 的来源）；
//   ② 标签（/new 的 TAGS）与附件在 §21.2 里没有对应字段，所以这一版**不画**它们 —— 画了就是假的；
//   ③ 未激活闸门：POST 会返回 403 auth.not_activated，这里按「先拦后提示」处理（能读不能写）。
const TITLE_MAX = 200;
const BODY_MAX = 20000;

const KINDS: Array<{ key: TopicKind; label: string }> = [
  { key: 'discussion', label: '讨论' },
  { key: 'resource', label: '资源' },
  { key: 'repost', label: '转载' },
];

export function ComposePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = useSession();
  const boards = useQuery({ queryKey: qk.boards(), queryFn: ({ signal }) => fetchBoards(signal), staleTime: 10 * 60_000 });

  const [board, setBoard] = useState<string>(params.get('board') ?? '');
  const [kind, setKind] = useState<TopicKind>('discussion');
  const [title, setTitle] = useState('');
  const [doc, setDoc] = useState({ json: '', html: '', length: 0 });

  const submit = useMutation({
    mutationFn: () => createTopic({ board_id: board, kind, title: title.trim(), content_md: doc.json }),
    onSuccess: (t) => void navigate(appPath('t/' + encodeURIComponent(t.id)), { replace: true }),
  });

  if (session.isLoading) return <Loading what='账号信息' />;
  if (session.error) return <ErrorState what='账号信息' error={session.error} />;

  if (!session.isLoggedIn) {
    return (
      <div className='flex flex-col gap-4'>
        <PageHeader title='发帖' description='登录后才能发帖。' />
        <Empty
          icon={Lock}
          title='你还没有登录'
          hint='未登录可以照常浏览；发帖、回复、上传需要先登录并激活邮箱。'
          action={<Button primary href={appPath('login?next=' + encodeURIComponent(appPath('new')))}>去登录</Button>}
        />
      </div>
    );
  }

  const allowed = can(session.session, 'post.create');
  const activated = session.session?.email_verified === true;
  const writable = allowed && activated;

  return (
    <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_288px]'>
      <div className='flex min-w-0 flex-col gap-4'>
        <PageHeader
          title={writable ? '发帖' : '发帖（当前账号还不能写）'}
          description='标题、分区、正文。配图直接插在正文里（它是正文节点，不是另一个字段）。'
        />

        {/* 写闸门：未登录已在上面的分支处理；这里是**已登录但不满足写条件**的两种情形，各说各的 */}
        {!writable ? (
          <FormAlert
            tone='warning'
            title={!activated ? '邮箱还没激活' : '账号没有发帖权限'}
            description={
              !activated
                ? '激活前可以照常浏览、收藏与下载；发帖、回复、上传会被后端拦下并返回 403 auth.not_activated。'
                : '当前角色没有 post.create 权限（后端会返回 403 common.forbidden）。可以联系管理员了解原因。'
            }
          >
            {!activated ? (
              <span className='mt-2'>
                <Button inline={false} height={ControlsHeight.S} href={appPath('register/verify')}>
                  去输入激活码
                </Button>
              </span>
            ) : null}
          </FormAlert>
        ) : null}

        {submit.isError ? (
          <FormAlert tone='error' title='没能发布' description={errorText(submit.error)} />
        ) : null}

        {/* 不能写时表单**仍然画出来但整块禁用**：只给一句提示，人不知道自己会失去什么（18-compose 的口径） */}
        <fieldset disabled={!writable || submit.isPending} className='m-0 flex flex-col gap-4 border-0 p-0'>
          <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
            <Input
              data-testid='compose-title'
              size={Size.FULL}
              label='标题'
              name='title'
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={isApiError(submit.error) ? submit.error.fields?.['title'] : undefined}
              help={'最多 ' + TITLE_MAX + ' 字（topics.title varchar(200)）。列表里只显示一行，把关键信息放前面。'}
              placeholder='一句话说清这篇是什么：作品名 / 问题 / 版本号'
            />

            <Select
              type={SelectType.INPUT}
              label='分区'
              data={(boards.data ?? []).map((b) => ({ key: b.slug, label: b.name }))}
              selected={board ? { key: board, label: (boards.data ?? []).find((b) => b.slug === board)?.name ?? board } : null}
              onSelect={(item) => {
                if (item) setBoard(String(item.key));
              }}
              disabled={!writable || boards.isPending}
            />
            {boards.isPending ? <span className='text-[11px] text-muted-foreground'>正在加载分区列表…</span> : null}
            {boards.isError ? (
              <ErrorState what='分区列表' error={boards.error} onRetry={() => void boards.refetch()} className='py-6' />
            ) : null}

            <div className='flex flex-col gap-2'>
              <span className='text-[12px] font-medium text-foreground'>类型</span>
              <div className='flex flex-wrap items-center gap-2'>
                {KINDS.map((k) => (
                  <Button
                    key={k.key}
                    ghost={k.key !== kind}
                    primary={k.key === kind}
                    active={k.key === kind}
                    height={ControlsHeight.S}
                    onClick={() => setKind(k.key)}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              <span className='text-[11px] text-muted-foreground'>
                类型决定列表里的徽标（讨论 / 资源 / 转载）；标签目录还没有端点，所以没有标签可挑。
              </span>
            </div>

            <MarkdownEditor
              value={doc.json}
              maxLength={BODY_MAX}
              compress
              allowOriginal
              onChange={(json, html) => setDoc((d) => ({ ...d, json, html }))}
              onLengthChange={(length) => setDoc((d) => ({ ...d, length }))}
              images={[]}
              onImagesChange={() => undefined}
            />
            <span data-testid='compose-count' className='text-[11px] text-muted-foreground'>
              正文字数 {doc.length} / {BODY_MAX}（正文里插的图算节点，不计入字数）
            </span>
          </section>

          <div className='flex flex-wrap items-center gap-3 border-t border-border pt-3'>
            <Button
              data-testid='compose-submit'
              primary
              inline={false}
              height={ControlsHeight.L}
              loader={submit.isPending}
              disabled={!writable || title.trim() === '' || board === '' || doc.length === 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? '发布中…' : '发布'}
            </Button>
            <span className='text-[11px] text-muted-foreground'>
              {missingText({ title, board, length: doc.length })} · 发布后进入待审或直接发布，取决于后端对你的信任等级
            </span>
          </div>
        </fieldset>
      </div>

      <aside className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-[12px]'>
        <h2 className='m-0 text-[13px] font-semibold text-foreground'>发之前确认三件事</h2>
        <ul className='m-0 flex list-none flex-col gap-1.5 p-0 text-muted-foreground'>
          <li>分区对不对：发错分区要找管理员移。</li>
          <li>标题能不能当摘要读：列表页只显示标题那一行。</li>
          <li>配图有没有插进正文：图片是正文节点，不显示为单独的附件位。</li>
        </ul>
      </aside>
    </div>
  );
}

function missingText(v: { title: string; board: string; length: number }): string {
  const missing = [
    v.title.trim() === '' ? '标题' : null,
    v.board === '' ? '分区' : null,
    v.length === 0 ? '正文' : null,
  ].filter((x): x is string => x !== null);
  return missing.length === 0 ? '三项齐了，可以发布' : '还缺：' + missing.join('、');
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  if (e.code === 'auth.email_unverified' || e.code === 'auth.not_activated') return '需要先激活邮箱。' + rid;
  if (e.code === 'forum.board_denied') return '这个分区不允许你发帖（BoardACL）。' + rid;
  if (e.code === 'forum.sanctioned') return '账号正在禁言中，暂时不能发帖。' + rid;
  return e.message + rid;
}

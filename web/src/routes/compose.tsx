import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { editorJsonToMarkdown } from '@/ui/rich/editor-json-to-markdown';
import { toEditorState } from '@/ui/rich/markdown-to-editor-json';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { PreviewPane } from '@/devroom/pages/18-compose/preview-pane';
import { SourceEditor } from '@/devroom/pages/18-compose/source-editor';
import { SubmitBar } from '@/devroom/pages/18-compose/submit-gate';
import { disabledReason, type Draft } from '@/devroom/pages/18-compose/draft';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { isApiError } from '@/lib/api/errors';
import {
  createSource,
  createTopic,
  deleteSource,
  fetchBoards,
  fetchTopic,
  updateSource,
  updateTopic,
  verifySource,
  type SourceInput,
  type TopicKind,
} from '@/lib/api/forum';
import { attachTopicImage } from '@/lib/api/media';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 发帖 / 编辑帖子（契约：POST /topics，权限点 topic.create；ACL 与禁言在 service 判 —— §21.2）。
//
// 页面里的件**全部来自设计稿 18-compose**（SubmitBar 的「为什么是灰的」、PreviewPane、disabledReason、
// SourceEditor），不再自己拼一份（2026-10-14 用户要求：设计稿有的就用设计稿的）。
//
// 与设计稿**有意的**三处差异，都不静默：
//   ① 类型 —— 设计稿画「标签」（TAGS 五个词），但全站没有标签目录端点、库里也没有 topic_tags 表；
//      后端真有的是 kind（discussion/resource/repost）→ 这里画 kind，不画假标签（画了就是假的）。
//   ② 附件位 —— 设计稿的 AttachmentSlot 自称「只做位置与提示、不接上传」；真站点摆一个传不上去的控件是骗人。
//   ③ 下载来源 —— 设计稿原来没有这一件（用户点名的缺失），现在同一件 SourceEditor 也进了 18-compose 房间。
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
  const qc = useQueryClient();
  const boards = useQuery({ queryKey: qk.boards(), queryFn: ({ signal }) => fetchBoards(signal), staleTime: 10 * 60_000 });

  const [board, setBoard] = useState<string>(params.get('board') ?? '');
  const [kind, setKind] = useState<TopicKind>('discussion');
  const [title, setTitle] = useState('');
  const [doc, setDoc] = useState({ json: '', html: '', length: 0 });
  const [previewOpen, setPreviewOpen] = useState(true);

  // 编辑模式：`?edit=<topicId>`。**复用这个页面而不是另写一个** —— 正文编辑器在这里已经装好了，
  // 另写一份就等于第二份「正文怎么编辑」的实现。（盲测发现「编辑自己的内容」在前端连函数都没有。）
  const editId = params.get('edit') ?? '';
  const editing = editId !== '';
  const existing = useQuery({
    queryKey: qk.topic(editId),
    queryFn: ({ signal }) => fetchTopic(editId, signal),
    enabled: editing,
  });
  // 初值必须在**编辑器首次挂载之前**就位：MarkdownEditor 的 InitialState 带 `done` 守卫，
  // 只在挂载那一刻读一次 value，空串就永久空白（2026-10-15 实测：编辑进去正文一直是空的 ——
  // 之前的 effect 回灌晚了一步，恰好撞上这条语义）。
  // 所以这里用**渲染期推导**（React 官方的「props 变了就调整 state」写法）而不是 effect：
  // 查询一到手就在同一次渲染里把 title/board/kind/doc 一起定下来，编辑器挂载时 value 已经是正文。
  // 只做一次（loadedFor 记 id）：填完就交给用户，别把他正在打的字覆盖掉。
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (editing && existing.data && loadedFor !== editId) {
    setLoadedFor(editId);
    setTitle(existing.data.title);
    setBoard(existing.data.board.slug);
    setKind(existing.data.kind);
    const md = existing.data.content_md ?? '';
    // content_md 是**历史列**（老站是 Markdown 纯文本）：不换算就灌编辑器 → 正文空白。
    setDoc({ json: toEditorState(md), html: existing.data.content_html ?? '', length: md.length });
  }
  // 编辑态在拿到详情前不画表单（否则编辑器会先以空值挂载，然后永远空着）
  const waitingTopic = editing && !existing.data;

  // 提交判据来自设计稿的 draft.ts（「三项齐了才能提交」+ 空编辑器的 '<p><br></p>' 不算正文）。
  // board 的 slug 来自接口，不是设计稿那张分区表 —— 所以只借它的判据，不借它的分区名。
  const draft: Draft = {
    title,
    board: board === '' ? null : (board as Draft['board']),
    tags: [],
    json: doc.json,
    html: doc.html,
  };
  const reason = disabledReason(draft);
  const boardName = (boards.data ?? []).find((b) => b.slug === board)?.name ?? '';

  const submit = useMutation({
    mutationFn: () => {
      // 上行的是 **Markdown**：后端 content_md 那一列过 goldmark → bluemonday 渲染成 content_html，
      // 把编辑器的 EditorState JSON 直接当 Markdown 发上去，库里存的就是那串 JSON（缺陷清单 D6）。
      // 发帖与编辑走同一条换算 —— 两处各写一份就会各自漂移（FIX-TOPIC 在反馈页已经踩过这个形状）。
      const content_md = editorJsonToMarkdown(doc.json);
      return editing
        ? updateTopic(editId, { title: title.trim(), content_md })
        : createTopic({ board, kind, title: title.trim(), content_md });
    },
    // 保存后回帖子页展示**真进度**：失效详情与楼层，否则 React-Query 拿缓存里的旧正文先渲一帧。
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: qk.topic(t.id) });
      void qc.invalidateQueries({ queryKey: qk.posts(t.id) });
      // 编辑保存后回帖子页：**这一次是「改完重提」**这个事实只有本页知道（PATCH 带 content_md 会把
      // review_state 打回 pending），用导航 state 交回去 —— 帖子页据此把横幅说成「已重新提交复审」。
      // 刷新后 state 消失、与首次投稿同形：这是**有意的诚实**（后端没有「第几次提交」这一列）。
      void navigate(routePath('t/' + encodeURIComponent(t.id)), {
        replace: true,
        state: editing ? { resubmitted: true } : undefined,
      });
    },
  });

  // 下载来源：后端按 topic id 挂（POST/PATCH/DELETE /topics/{id}/sources），且只允许 kind=resource，
  // 所以这一件只在「编辑已有的资源帖」时画得出来。改完 invalidate 帖子详情，列表就是服务端那份。
  const sourceTopic = editing ? editId : '';
  const refreshTopic = () => void qc.invalidateQueries({ queryKey: qk.topic(editId) });
  const saveSource = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: SourceInput }) =>
      id ? updateSource(sourceTopic, id, body) : createSource(sourceTopic, body),
    onSuccess: refreshTopic,
  });
  const removeSource = useMutation({
    mutationFn: (id: string) => deleteSource(sourceTopic, id),
    onSuccess: refreshTopic,
  });
  const checkSource = useMutation({
    mutationFn: (id: string) => verifySource(sourceTopic, id),
    onSuccess: refreshTopic,
  });
  const sourceError = saveSource.error ?? removeSource.error ?? checkSource.error;

  // 配图（拍板第三轮「图文帖整块做完」）：media 的通道是 POST /topics/{id}/images —— **帖 id 是必须的**，
  // 所以发新帖时传不上去（那时还没有 id）。这是端点的形状，不是前端偷懒：与其画一个点了必失败的入口，
  // 不如在编辑态真接上、在新帖态说清「发布之后从帖子页点编辑回来配图」。
  // 传上去的图由编辑器插成**正文节点**（图片是正文的一部分），而 sort=0 的那张**自动成为列表封面**
  // （后端 pgsql/topics.go:60 取的就是它），所以没有第二个「设封面」的动作。
  const uploadImage = (file: Blob): Promise<string> => {
    if (!editing) return Promise.reject(new Error('配图要等这篇发布之后才能加'));
    return attachTopicImage(editId, file).then((a) => a.url);
  };

  if (waitingTopic) return <Loading what='帖子内容' />;
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
          action={<Button primary href={appPath('login?next=' + encodeURIComponent(routePath('new')))}>去登录</Button>}
        />
      </div>
    );
  }

  // 权限键要写**后端真实的那个**：后端 24 个权限键里是 `topic.create`，没有 `post.create` ——
  // 写错的话连 superadmin 都过不了（perms 里根本没这个字符串），发帖框判成「没权限」。
  const allowed = can(session.session, 'topic.create');
  const activated = session.session?.email_verified === true;
  const writable = allowed && activated;
  const isResource = existing.data?.kind === 'resource';

  return (
    <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_288px]'>
      <div className='flex min-w-0 flex-col gap-4'>
        <PageHeader
          title={editing ? '编辑帖子' : writable ? '发帖' : '发帖（当前账号还不能写）'}
          description={
            editing
              ? '改完保存即生效；标题与正文都会更新（分区不在这一步改）。'
              : '标题、分区、正文。配图直接插在正文里（它是正文节点，不是另一个字段）。'
          }
        />

        {/* 写闸门：未登录已在上面的分支处理；这里是**已登录但不满足写条件**的两种情形，各说各的 */}
        {!writable ? (
          <FormAlert
            tone='warning'
            title={!activated ? '邮箱还没激活' : '账号没有发帖权限'}
            description={
              !activated
                ? '激活前可以照常浏览、收藏与下载；发帖、回复、上传会被后端拦下并返回 403 auth.not_activated。'
                : '当前角色没有 topic.create 权限（后端会返回 403 common.forbidden）。可以联系管理员了解原因。'
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
          <FormAlert tone='error' title={editing ? '没能保存' : '没能发布'} description={errorText(submit.error)} />
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
                    data-testid={'compose-kind-' + k.key}
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
                类型决定列表里的徽标（讨论 / 资源 / 转载）；标签目录还没有端点，所以没有标签可挑 ——
                设计稿画的那五个标签在库里没有对应的表。
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
              // 编辑态才给上传口：新帖还没有 topic id，图片挂不上去（见上面 uploadImage 的注释）。
              onUpload={editing ? uploadImage : undefined}
            />
            <span data-testid='compose-count' className='text-[11px] text-muted-foreground'>
              正文字数 {doc.length} / {BODY_MAX}（正文里插的图算节点，不计入字数）
            </span>
            {/* 新帖态说清「配图什么时候能加」——不能传的原因是端点绑在主题上，不是这里没做 */}
            {!editing ? (
              <p
                data-testid='compose-images-later'
                className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground'
              >
                配图要等这篇发布之后：上传端点按帖子挂（POST /topics/{'{'}id{'}'}/images），发新帖时还没有 id。
                发布后从帖子页点「编辑」回来，正文里就多出「添加图片」与拖拽落点；第一张会自动成为列表封面。
              </p>
            ) : (
              <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
                配图直接插在正文光标处（图片是正文节点，不是另一个字段）。每帖最多 9 张、单张压缩后上限 2MiB；
                排序第一张（sort=0）就是列表封面。图片对别人的可见性跟着**这篇的审核态**走：过审之后才对外可见。
              </p>
            )}

            {/* 新建时还没有 topic id，来源挂不上 —— 明说，别让人找不到入口（设计稿的这一件在编辑态） */}
            {!editing && kind === 'resource' ? (
              <p
                data-testid='compose-sources-later'
                className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground'
              >
                下载来源要等这篇发布之后才能加：后端按帖子 id 挂来源（POST /topics/{'{'}id{'}'}/sources），
                发完从帖子页点「编辑」回到这里填网盘 / 官网 / 仓库地址。
              </p>
            ) : null}
          </section>

          {editing && existing.data ? (
            isResource ? (
              <SourceEditor
                items={existing.data.sources ?? []}
                disabled={!writable}
                busy={saveSource.isPending || removeSource.isPending || checkSource.isPending}
                error={sourceError ? errorText(sourceError) : null}
                fieldErrors={isApiError(saveSource.error) ? saveSource.error.fields : undefined}
                onSave={(body, id) => saveSource.mutateAsync({ id, body })}
                onDelete={(row) => removeSource.mutateAsync(row.id)}
                onVerify={(row) => checkSource.mutateAsync(row.id)}
              />
            ) : (
              <p
                data-testid='compose-sources-other-kind'
                className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground'
              >
                下载来源只挂在资源帖上（后端 kind=resource，否则回 forum.not_resource）。
                要把这篇变成资源帖，得由管理员改类型。
              </p>
            )
          ) : null}

          <SubmitBar reason={reason} busy={submit.isPending} onSubmit={() => submit.mutate()} label={editing ? '保存修改' : '发布'} />
        </fieldset>
      </div>

      <aside className='flex flex-col gap-3'>
        <Button
          data-testid='preview-toggle'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(previewOpen ? EyeOff : Eye)}
          aria-pressed={previewOpen}
          onClick={() => setPreviewOpen((v) => !v)}
        >
          {previewOpen ? '收起预览' : '展开预览'}
        </Button>
        <PreviewPane draft={draft} show={previewOpen} onHide={() => setPreviewOpen(false)} boardName={boardName} />

        <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-[12px]'>
          <h2 className='m-0 text-[13px] font-semibold text-foreground'>提交后会怎样</h2>
          <p className='m-0 leading-relaxed text-muted-foreground'>
            发布后进入待审或直接发布，取决于后端对你的信任等级；审核期间只有你自己能看到这篇。
          </p>
          <ul className='m-0 flex list-none flex-col gap-1.5 p-0 text-muted-foreground'>
            <li>分区对不对：发错分区要找管理员移。</li>
            <li>标题能不能当摘要读：列表页只显示标题那一行。</li>
            <li>配图有没有插进正文：图片是正文节点，不显示为单独的附件位。</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  // 参数类的错，后端把原因放在 fields 里，error.message 只有「参数错误」——把真正那句话抬出来
  const fields = e.fields ? Object.values(e.fields).join('；') : '';
  if (fields !== '') return fields + rid;
  if (e.code === 'auth.email_unverified' || e.code === 'auth.not_activated') return '需要先激活邮箱。' + rid;
  if (e.code === 'forum.board_denied') return '这个分区不允许你发帖（BoardACL）。' + rid;
  if (e.code === 'forum.sanctioned') return '账号正在禁言中，暂时不能发帖。' + rid;
  if (e.code === 'forum.not_resource') return '只有资源帖可以挂下载来源。' + rid;
  return e.message + rid;
}

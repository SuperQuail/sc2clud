import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Tag from '@jetbrains/ring-ui-built/components/tag/tag';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Eye, EyeOff, Tag as TagIcon } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { AttachmentSlot, type Attachment } from '@/ui/rich/attachment-slot';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { roomHref } from '@/devroom/room-links';
import { BOARDS } from '@/devroom/pages/12-topic/mock';
import { BoardCover } from '@/devroom/pages/03-navigation/board-rail';
import { PreviewPane } from './preview-pane';
import { SourceEditor } from './source-editor';
import { TOPIC } from '@/devroom/pages/12-topic';
import { toEditorState } from '@/ui/rich/markdown-to-editor-json';
import { BackLinks, SubmitBar, SubmitResult } from './submit-gate';
import { disabledReason, type Draft } from './draft';
import type { SourceInput } from '@/lib/api/forum';
import type { SourceRow } from './source-form';
import {
  ATTACH_ACCEPT,
  ATTACH_HINT,
  BODY_MAX,
  BOARD_OPTIONS,
  DEFAULT_BOARD,
  DEMO_SOURCES,
  IMAGE_MAX,
  MENTIONS,
  NOT_ACTIVATED,
  REVIEW_HINT,
  TAG_MAX,
  TAG_SUGGESTION_HINT,
  TAGS,
  TITLE_MAX,
  tagLabel,
  tagType,
  type BoardKey,
  type ComposeTag,
} from './data';

// DevRoom 18 · 发帖页。
//
// 编辑态（2026-10-15）：?edit=<topicId> 预灌标题与正文 ——「编辑帖子」不再走帖内小弹层，
// 房间与产品同口径：12-topic 的「编辑」按钮跳到这里；保存动作在真页面走 PATCH /topics/:id，
// 房间里的提交仍是演示态（不外呼）。
//
// **这一页不造新控件，只把已有的件组装起来**：正文用 @/ui/rich/markdown-editor（配图是它的正文节点）、
// 附件位用 @/ui/rich/attachment-slot、标题/分区/标签用 Ring 的 Input/Select/Tag、预览走 @/ui/markdown 那条链。
// 分区与标签数据来自 12-topic 与 14-home 的既有常量，本页不另编一套（见 data.ts 的出处注释）。
//
// 两个盲审独立报的洞就是这一页要填的：「写帖子这件事本身没有页面」（一号）与「4/5 条发帖整段流程无落点」（二号）。
// 两条硬约束照着做：
//   ① **不许静默**：按钮为什么灰的写在按钮下面；提交后说清进的是哪条路径、去哪里看（submit-gate.tsx）；
//   ② **写闸门**：未激活（users.activated_at 为空）不能发帖 —— 这是全站唯一的写闸门（后端开工前拍板 §9.4），
//      所以这一页必须有「未激活」态，而且**草稿就画成禁用**（不是提交时才 403）。
//
// 演示开关（只影响 DevRoom 的初始态，真页面里没有）：
//   ?activated=0            未激活态（写闸门拦下）
//   ?preview=closed         预览收起
//   ?board=<slug>           从帖子页/首页带过来的分区（非法值回落到默认分区，不报错）
//   ?demo=mention           自动敲一个 @（复用编辑器自带的开发期开关）
export default function ComposePage() {
  const params = new URLSearchParams(location.search);
  const editId = params.get('edit') ?? '';
  const editing = editId !== '';
  const [activated, setActivated] = useState(params.get('activated') !== '0');
  const [previewOpen, setPreviewOpen] = useState(params.get('preview') !== 'closed');
  const [trusted, setTrusted] = useState(false);
  // ?board= 是「从哪儿来」的那一半：帖子页与首页把当前分区带过来，人不用再选一次。
  // 非法值一律回落到默认分区（URL 是外部输入，不拿它直接当 state）。
  const [board, setBoard] = useState<BoardKey | null>(() => {
    const key = params.get('board');
    return BOARD_OPTIONS.some((b) => b.key === key) ? (key as BoardKey) : DEFAULT_BOARD;
  });
  const [tags, setTags] = useState<ComposeTag[]>(['resource']);
  const [title, setTitle] = useState('');
  const [doc, setDoc] = useState<{ json: string; html: string; length: number }>({ json: '', html: '', length: 0 });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 下载来源：房间里只改本地 state（真页面走 /topics/{id}/sources 的四条端点）
  const [sources, setSources] = useState<SourceRow[]>(DEMO_SOURCES);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  // 编辑态预灌：房间里唯一的 demo 帖就是 12-topic 的那份 mock。
  // **渲染期推导而不是 effect**：MarkdownEditor 只在挂载那一刻读 value（InitialState 的 done 守卫），
  // effect 回灌晚一步 → 正文永远空白（2026-10-15 实测，产品页同一个坑）。
  const [prefilled, setPrefilled] = useState(false);
  if (editing && !prefilled) {
    setPrefilled(true);
    setTitle(TOPIC.title);
    const md = TOPIC.content_md ?? '';
    setDoc({ json: toEditorState(md), html: TOPIC.content_html ?? '', length: md.length });
    const key = TOPIC.board.slug;
    setBoard(BOARD_OPTIONS.some((b) => b.key === key) ? (key as BoardKey) : DEFAULT_BOARD);
  }
  const [submitted, setSubmitted] = useState<Draft | null>(null);

  const post: Draft = { title, board, tags, json: doc.json, html: doc.html };
  const reason = disabledReason(post);

  function submit() {
    // 设计稿：只演示「提交中 → 结果态」，不真的发请求（真页面走 lib/api/client）。
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      setSubmitted(post);
      window.scrollTo({ top: 0 });
    }, 700);
  }

  async function saveSource(body: SourceInput, id?: string) {
    setSourceBusy(true);
    await new Promise((r) => window.setTimeout(r, 250)); // 演示里也要看得出「保存中」
    setSourceBusy(false);
    setSources((list) =>
      id
        ? list.map((s) =>
            s.id === id
              ? { ...s, provider: body.provider, label: body.label ?? '', url: body.url, extraction_code: body.extraction_code ?? null, size: body.size ?? '' }
              : s,
          )
        : list.concat({
            id: 's_demo_' + Date.now(),
            provider: body.provider,
            label: body.label ?? '',
            url: body.url,
            extraction_code: body.extraction_code ?? null,
            size: body.size ?? '',
          }),
    );
  }

  async function deleteSource(row: SourceRow) {
    setSources((list) => list.filter((s) => s.id !== row.id));
  }

  async function verifySource(row: SourceRow) {
    setSources((list) =>
      list.map((s) => (s.id === row.id ? { ...s, verified_at: new Date().toISOString(), upkeep: 'active' } : s)),
    );
  }

  function reset() {
    setSubmitted(null);
    setTitle('');
    setBoard(DEFAULT_BOARD);
    setTags([]);
    setDoc({ json: '', html: '', length: 0 });
    setAttachments([]);
  }

  if (!activated) {
    return (
      <div className='flex flex-col gap-4'>
        <PageHead title='发帖' subtitle='未激活账号的这条路径：能读，不能写。' />
        <FormAlert tone='warning' title={NOT_ACTIVATED.title} description={NOT_ACTIVATED.description}>
          <span className='mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground'>
            <span>
              后端返回 <code className='rounded-sm bg-muted px-1'>{NOT_ACTIVATED.code}</code>（403），不是 401。
            </span>
            <span>{NOT_ACTIVATED.hint}</span>
          </span>
          <span className='mt-2 flex flex-wrap items-center gap-2'>
            <Button primary inline={false} height={ControlsHeight.S} href={roomHref('16-auth')}>
              {NOT_ACTIVATED.action}
            </Button>
            <Button data-testid='demo-activate' inline={false} height={ControlsHeight.S} onClick={() => setActivated(true)}>
              模拟激活（演示开关）
            </Button>
          </span>
        </FormAlert>
        {/* 未激活时**表单仍然画出来、整块禁用**：只给一句提示的话，人不知道自己会失去什么。 */}
        <fieldset disabled className='m-0 flex flex-col gap-4 border-0 p-0'>
          <DraftFields
            title={title}
            onTitle={setTitle}
            board={board}
            onBoard={setBoard}
            tags={tags}
            onTags={setTags}
            doc={doc}
            onDoc={setDoc}
            attachments={attachments}
            onAttachments={setAttachments}
            disabled
          />
          {/* 未激活时来源编辑器也画出来、整块禁用（与正文同一口径），不是藏起来 */}
          <SourceEditor items={sources} disabled onSave={saveSource} onDelete={deleteSource} onVerify={verifySource} />
        </fieldset>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <PageHead
        title={submitted ? '发帖 · 已提交' : editing ? '编辑帖子' : '发帖'}
        subtitle='标题、分区、标签、正文、配图、附件位 —— 组装已有的件，不造新控件。'
        actions={<DemoBar activated={activated} onActivated={setActivated} trusted={trusted} onTrusted={setTrusted} />}
      />

      {/* 结果态**替换表单**（不是叠在下面）：提交完还留着「提交审核」按钮，人会以为没提交上。
          草稿不丢：点「再写一篇」或点「回帖子的样子」都回到表单，内容还在（reset 才清空）。 */}
      {submitted ? (
        <>
          <SubmitResult draft={submitted} trusted={trusted} onAgain={reset} onBack={() => setSubmitted(null)} />
          <section className='flex flex-col gap-2'>
            <h2 className='m-0 text-[13px] font-semibold text-foreground'>刚才提交的正文</h2>
            <PreviewPane draft={submitted} />
          </section>
          <BackLinks board={submitted.board} />
        </>
      ) : (
        <div className='grid grid-cols-1 items-start gap-x-5 gap-y-4 xl:grid-cols-[minmax(0,1fr)_288px]'>
          <main className='flex min-w-0 flex-col gap-4'>
            <DraftFields
              title={title}
              onTitle={setTitle}
              board={board}
              onBoard={setBoard}
              tags={tags}
              onTags={setTags}
              doc={doc}
              onDoc={setDoc}
              attachments={attachments}
              onAttachments={setAttachments}
              disabled={false}
            />
            {/* 来源编辑器：真页面只在「编辑已有的资源帖」时画（后端按 topic id 挂来源，发新帖时还没有 id）。
                房间里整件画出来，好把「空 / 有数据 / 禁用」三种状态都看到。 */}
            <p className='m-0 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground'>
              下载来源（编辑器演示）：真页面在编辑已有的资源帖时才画它 —— 后端按帖子 id 挂来源，发新帖时还没有 id。发完点帖子页的「编辑」回来加。
            </p>
            <SourceEditor
              items={sources}
              busy={sourceBusy}
              onSave={saveSource}
              onDelete={deleteSource}
              onVerify={verifySource}
            />
            <SubmitBar reason={reason} busy={busy} onSubmit={submit} />
          </main>

          <aside className='flex min-w-0 flex-col gap-4'>
            <BoardCard slug={board} />
            <ReviewCard trusted={trusted} />
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
            {/* 窄屏 288px 的栏放正文预览会逐字换行：那一档用「展开/收起」的折叠，不硬塞分栏。
                1280+ 才是真分栏（右栏 288px 够放）。 */}
            <PreviewPane draft={post} show={previewOpen} onHide={() => setPreviewOpen(false)} />
            <BackLinks board={board} />
          </aside>
        </div>
      )}
    </div>
  );
}

/** 页面标题行。演示条挂在 actions 上（设计稿开关与页面内容分开，别混进表单）。 */
function PageHead({ title, subtitle, actions }: { title: string; subtitle: string; actions?: React.ReactNode }) {
  return (
    <header className='flex flex-wrap items-end justify-between gap-3'>
      <div>
        <h1 className='m-0 text-[20px] font-semibold text-foreground'>{title}</h1>
        <p className='m-0 text-[13px] text-muted-foreground'>{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}

/** 设计稿开关：两态各出一张图、也能分享链接。真页面没有这一条。 */
function DemoBar({
  activated,
  onActivated,
  trusted,
  onTrusted,
}: {
  activated: boolean;
  onActivated: (v: boolean) => void;
  trusted: boolean;
  onTrusted: (v: boolean) => void;
}) {
  return (
    <ButtonSet className='flex-wrap gap-1'>
      <Button data-testid='demo-activated' primary={activated} ghost={!activated} active={activated} height={ControlsHeight.S} onClick={() => onActivated(true)}>
        已激活
      </Button>
      <Button data-testid='demo-unactivated' primary={!activated} ghost={activated} active={!activated} height={ControlsHeight.S} onClick={() => onActivated(false)}>
        未激活
      </Button>
      <Button data-testid='demo-trusted' primary={trusted} ghost={!trusted} active={trusted} height={ControlsHeight.S} onClick={() => onTrusted(!trusted)}>
        trusted 作者
      </Button>
    </ButtonSet>
  );
}

/** 表单字段区。未激活态要**同一份字段画出来但禁用**，所以抽成一个件、用 disabled 透传，
 *  而不是在页面里写两遍（写两遍必然漂移）。 */
function DraftFields({
  title,
  onTitle,
  board,
  onBoard,
  tags,
  onTags,
  doc,
  onDoc,
  attachments,
  onAttachments,
  disabled,
}: {
  title: string;
  onTitle: (v: string) => void;
  board: BoardKey | null;
  onBoard: (v: BoardKey) => void;
  tags: ComposeTag[];
  onTags: (v: ComposeTag[]) => void;
  doc: { json: string; html: string; length: number };
  /** 用**函数式更新**：onChange 与 onLengthChange 是在同一次编辑器事件里先后调用的，
   *  各自拿到的 doc 是同一份渲染期快照 —— 传值时后调用的那个会把另一个刚写的字段覆盖回旧值
   *  （实测：正文打了 10 个字，计数器仍显示 0/20000）。 */
  onDoc: React.Dispatch<React.SetStateAction<{ json: string; html: string; length: number }>>;
  attachments: Attachment[];
  onAttachments: (v: Attachment[]) => void;
  disabled: boolean;
}) {
  const selected = BOARD_OPTIONS.find((b) => b.key === board) ?? null;
  const rest = TAGS.filter((t) => !tags.includes(t.key));

  return (
    <section className='flex flex-col gap-4 rounded-lg border border-border bg-card p-4'>
      <Input
        data-testid='compose-title'
        size={Size.FULL}
        label='标题'
        disabled={disabled}
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => onTitle(e.target.value)}
        placeholder='一句话说清这篇是什么：作品名 / 问题 / 版本号'
        help={'最多 ' + TITLE_MAX + ' 字（数据库 topics.title varchar(200)）。列表里只显示一行，把关键信息放前面。'}
      />

      <div className='flex flex-col gap-2'>
        <Select
          type={SelectType.INPUT}
          data={BOARD_OPTIONS}
          selected={selected}
          onSelect={(item) => {
            if (item) onBoard(item.key as BoardKey);
          }}
          label='分区'
          disabled={disabled}
        />
        <p className='m-0 text-[11px] text-muted-foreground'>发错分区会被管理员移走；「公告」只有管理员能发。</p>
      </div>

      <div className='flex flex-col gap-2'>
        <span className='flex items-center gap-1.5 text-[12px] font-medium text-foreground'>
          <TagIcon aria-hidden className='size-3.5' />
          标签
          <span className='font-normal text-muted-foreground'>
            {tags.length} / {TAG_MAX}
          </span>
        </span>
        <div className='flex flex-wrap items-center gap-2'>
          {tags.map((t) => (
            <Tag
              key={t}
              data-testid={'compose-tag-' + t}
              tagType={tagType(t)}
              onRemove={disabled ? undefined : () => onTags(tags.filter((x) => x !== t))}
            >
              {tagLabel(t)}
            </Tag>
          ))}
          {rest.map((t) => (
            <Button
              key={t.key}
              data-testid={'compose-add-' + t.key}
              inline={false}
              height={ControlsHeight.S}
              disabled={disabled || tags.length >= TAG_MAX}
              onClick={() => onTags([...tags, t.key])}
            >
              {'+ ' + t.label}
            </Button>
          ))}
        </div>
        <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
          {TAG_SUGGESTION_HINT}
          标签目录属待补接口（data.ts 里写了每一个词的出处）。
        </p>
      </div>

      {/* 正文与配图**是同一个控件**：图片是正文里的节点，不是另一个字段（09-rich 已定）。
          传 onImagesChange 才会出现上传入口与拖拽落点，所以这个 prop 必须给。 */}
      <div className='flex flex-col gap-2'>
        <MarkdownEditor
          value={doc.json}
          candidates={MENTIONS}
          maxLength={BODY_MAX}
          maxImages={IMAGE_MAX}
          compress
          allowOriginal
          onChange={(json, html) => onDoc((d) => ({ ...d, json, html }))}
          onLengthChange={(length) => onDoc((d) => ({ ...d, length }))}
          images={[]}
          onImagesChange={() => undefined}
          // 房间里也要走**真**上传这条路（给 onUpload 才会把服务端地址写进正文节点）。
          // 这一页不落库、没有后端，所以回一个本地预览地址：真页面是 POST /topics/{id}/images，
          // 回的是 /img/<hash>（见 routes/compose.tsx 的 uploadImage 与 lib/api/media.ts）。
          onUpload={(file) => Promise.resolve(URL.createObjectURL(file))}
        />
        <p data-testid='compose-body-count' className='m-0 text-[11px] text-muted-foreground'>
          正文字数 {doc.length} / {BODY_MAX}（正文里插的图算图片节点，不计入字数）
        </p>
      </div>

      <div className='flex flex-col gap-2'>
        <h2 className='m-0 text-[13px] font-semibold text-foreground'>附件（只做位置与提示，本轮不接上传）</h2>
        <AttachmentSlot files={attachments} onChange={onAttachments} accept={ATTACH_ACCEPT} hint={ATTACH_HINT} disabled={disabled} />
        <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
          附件类型/大小/存放位置还没定（全站现在只有图片上传控件），
          所以这一格只把「选了哪些、会不会被拒」摆出来，不做假的上传进度。
        </p>
      </div>
    </section>
  );
}

/** 右栏第一格：分区身份。发帖人最需要确认的是「我在哪个分区发」，所以把统计也带上。 */
function BoardCard({ slug }: { slug: BoardKey | null }) {
  const board = slug === null ? null : (BOARDS.find((b) => b.slug === slug) ?? null);
  if (!board) {
    return (
      <section className='rounded-lg border border-dashed border-border p-4 text-[12px] text-muted-foreground'>
        还没选分区。分区决定这篇出现在哪个列表里，也是唯一不能自己随便改的字段（要管理员移）。
      </section>
    );
  }
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
      <div className='flex items-start gap-3'>
        {/* 封面走**唯一那份** BoardCover：BOARDS 的封面字段改回后端 DTO 的真名 cover_hash 之后，
            这里原来那句 board.cover 就没有了（D21 的同一处字段名债）。 */}
        <BoardCover hash={board.cover_hash} className='size-10 rounded-md' />
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <h2 className='truncate text-[15px] font-semibold text-foreground'>{board.name}</h2>
          <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>{board.description}</p>
        </div>
      </div>
      <p className='m-0 text-[11px] text-muted-foreground'>
        今日新帖 {board.today_count} · 帖子 {board.topic_count} · 成员 {board.member_count}
      </p>
    </section>
  );
}

/** 右栏第二格：提交后会怎样 —— 「不许静默」的另一半，在按提交**之前**就说明白。 */
function ReviewCard({ trusted }: { trusted: boolean }) {
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-[12px]'>
      <h2 className='m-0 text-[13px] font-semibold text-foreground'>提交后会怎样</h2>
      <p className='m-0 leading-relaxed text-muted-foreground'>{trusted ? REVIEW_HINT.trusted : REVIEW_HINT.normal}</p>
      <p className='m-0 leading-relaxed text-muted-foreground'>
        未激活账号不能发帖（全站唯一的写闸门）；驳回理由显示在帖子页顶部，可以改完重提 —— 但「编辑帖子」的入口还没做。
      </p>
    </section>
  );
}

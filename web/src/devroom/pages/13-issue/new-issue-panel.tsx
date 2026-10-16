import { Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { resolveKindName } from '../12-topic/_task/types';
import { FALLBACK_KIND_OPTIONS, IssueKindButton } from './shared';
import type { IssueKind } from './types';

// 反馈页里**「填一条新反馈」那块表单区**（D7，2026-10-14 用户要求：不再是弹窗，而是页内一整块界面）。
//
// 为什么单拆一个文件而不是留在 routes/issues.tsx 里：产品的宿主文件已经 560 行（gate:size 上限 500，
// 它已在 PENDING 里挂着「拆出列表与详情」），把版面再塞进去就是往超限的方向加 —— 而这一块**一个字都不取数**，
// 天生就是 View。编辑器按需加载（与 12-topic 的弹层同一个理由）：Lexical 那一包约 100KB gzip，
// 不进公开首屏，只有真要填反馈时才下载。
//
// 校验与提交逐条保留原来的三件：标题 ≥4 字、正文非空、提交回调给编辑器真源（bodyJson）。
// 换成后端认的 Markdown 是宿主的事（routes/issues.tsx 的 editorJsonToMarkdown）—— 这一层不认识契约
// 里正文该长什么样，只把编辑器给的两份（json / html）原样交出去。
const BodyEditor = lazy(() => import('./new-issue-form').then((m) => ({ default: m.NewIssueFormEditor })));

/** 「标题 + 正文」两格的形状。默认那份是按需加载的真编辑器；
 *  测试注入一份假的（Lexical 在 jsdom 里不产生真实的编辑事件，测它等于测库）。 */
export type IssueEditorProps = {
  title: string;
  onTitle: (v: string) => void;
  onBody: (json: string, html: string) => void;
  onLength: (n: number) => void;
};

/** 编辑器真源（EditorState JSON）；提交时由宿主换成 Markdown */
export type IssueDraft = { kind: IssueKind; title: string; bodyJson: string };

export function NewIssuePanel({
  initialKind,
  pending,
  onClose,
  onSubmit,
  header,
  kinds = FALLBACK_KIND_OPTIONS,
  Editor = BodyEditor,
}: {
  initialKind: IssueKind;
  /** 提交中：按钮进 loading，且不许重复提交（同一个 client_token 的幂等是后端的事，前端别抢） */
  pending?: boolean;
  onClose: () => void;
  onSubmit: (draft: IssueDraft) => void;
  /** 宿主塞的额外头部（例如未登录时那句引导），不给就什么都不渲染 */
  header?: ReactNode;
  /** 值域（`GET /issues/kinds`）。不给就用兜底四类 —— 房间与端点未回来时是这一档。 */
  kinds?: { key: IssueKind; name: string }[];
  /** 标题 + 正文那两格（默认是按需加载的真编辑器） */
  Editor?: ComponentType<IssueEditorProps>;
}) {
  const [kind, setKind] = useState<IssueKind>(initialKind);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState({ json: '', html: '' });
  const [length, setLength] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (title.trim().length < 4) {
      setError('标题至少 4 个字，写清楚「在哪、什么现象」修复最快');
      return;
    }
    if (length === 0) {
      setError('正文还没写');
      return;
    }
    setError(null);
    onSubmit({ kind, title: title.trim(), bodyJson: body.json });
  }

  return (
    <section
      data-testid='new-issue-form'
      aria-label='我要反馈'
      className='mt-4 flex flex-col gap-4 rounded-lg border border-border bg-card p-4'
    >
      <div className='flex flex-col gap-1'>
        <h2 className='text-base font-semibold text-foreground'>我要反馈</h2>
        <p className='text-[12px] text-muted-foreground'>
          先选类型，再写标题与正文。提交后会存到服务端，并立刻出现在下面的列表里。
        </p>
        {header}
      </div>

      <div className='flex flex-col gap-2'>
        <span className='text-[12px] font-medium text-foreground' id='new-issue-kind-label'>
          类型
        </span>
        <div role='group' aria-labelledby='new-issue-kind-label' className='flex flex-wrap items-center gap-2'>
          {kinds.map((k) => (
            // 选中环画在容器上：共享件没有 className prop，也不该为这一处去改它的外观
            <span
              key={k.key}
              className={'inline-flex rounded-md ' + (kind === k.key ? 'ring-[3px] ring-ring/60' : 'ring-1 ring-transparent')}
            >
              <IssueKindButton kind={k.key} name={k.name} onSelect={setKind} />
            </span>
          ))}
        </div>
        <span className='text-[11px] text-muted-foreground'>
          当前选择：{resolveKindName(kind, kinds.find((k) => k.key === kind)?.name)}
        </span>
      </div>

      <Suspense fallback={<p className='text-[13px] text-muted-foreground'>正在加载编辑器…</p>}>
        <Editor title={title} onTitle={setTitle} onBody={(json, html) => setBody({ json, html })} onLength={setLength} />
      </Suspense>

      {error ? (
        <p role='alert' className='text-[12px] text-destructive'>
          {error}
        </p>
      ) : null}

      <div className='flex items-center justify-end gap-2'>
        <Button onClick={onClose}>收起</Button>
        <Button primary loader={pending} disabled={pending} onClick={submit}>
          提交反馈
        </Button>
      </div>
    </section>
  );
}

import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { AiTestView } from '@/lib/api/admin';
import { DisabledReason, Pill, Toolbar } from '../bits';

// AI 屏的两个纯展示件与三个小工具（从 ai-review.tsx 拆出来：gate:size 单文件 ≤ 500 行）。
// 拆的边界是「有没有 hook / 有没有请求」：这里是纯函数与纯展示，那一边是带状态的表单。

/** 连通测试失败的**就地**回执（D12）：哪一档 + 后端原话，一行说清，不落进错误边界。 */
export type AiTestFailure = { kind: string; label: string; message: string };

/** 连通测试的回执：三种形态一眼分得开（成功 / 鉴权 / 网络超时）。
 *
 *  D33③ 起带 topic_id 的那一次试跑也走这里（**真发一条真帖子的 payload，含图**）：
 *  那时回执必须回答「**这次判了几张图**」—— 只说 verdict 等于把图片那一半藏起来。 */
export function TestResult({ result }: { result: AiTestView }) {
  const kind = kindOf(result.reason || result.raw);
  if (result.verdict) {
    return (
      <div data-testid='ai-test-result' className='rounded-md border border-border px-2 py-2'>
        <span className='flex flex-wrap items-center gap-1.5'>
          <CheckCircle2 size={14} aria-hidden className='text-primary' />
          <Pill tone='ok'>连通成功</Pill>
          <Pill tone={result.verdict === 'approve' ? 'ok' : result.verdict === 'reject' ? 'danger' : 'warn'}>{result.verdict}</Pill>
          <span className='text-[12px] text-foreground'>{result.model} · {result.latency_ms} ms</span>
          {result.topic_id > 0 ? (
            <Pill tone={result.image_count > 0 ? 'ok' : 'neutral'}>{'判了 ' + result.image_count + ' 张图'}</Pill>
          ) : null}
          {result.image_skipped > 0 ? <Pill tone='danger'>{'没发 ' + result.image_skipped + ' 张'}</Pill> : null}
        </span>
        <p className='mt-1.5 text-[12px] leading-relaxed text-foreground'>{result.reason}</p>
        {result.categories.length > 0 ? (
          <span className='mt-1 flex flex-wrap items-center gap-1'>
            {result.categories.map((c) => <span key={c} className='rounded-sm bg-muted px-1 text-[10px] text-muted-foreground'>{c}</span>)}
          </span>
        ) : null}
        <p className='mt-1.5 break-all font-mono text-[11px] text-muted-foreground'>{result.raw}</p>
        {result.topic_id > 0 ? (
          <p className='mt-1 text-[11px] leading-relaxed text-muted-foreground'>
            这一次是**真发**出去的一条真帖子（含图），但**一个字都没落库**：主题状态、判定事件、配额都没动。
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={'rounded-md border px-2 py-2 ' + (kind === 'danger' ? 'border-destructive/40 bg-destructive/8' : 'border-border bg-muted/50')}>
      <span className='flex flex-wrap items-center gap-1.5'>
        <AlertTriangle size={14} aria-hidden className={kind === 'danger' ? 'text-destructive' : 'text-muted-foreground'} />
        <Pill tone={kind === 'danger' ? 'danger' : 'warn'}>{kind === 'danger' ? '密钥 / 鉴权' : '网络 / 超时'}</Pill>
        <span className='text-[12px] text-foreground'>没拿到可解析的判定</span>
      </span>
      <p className='mt-1.5 text-[11px] leading-relaxed text-muted-foreground'>{result.reason || '（后端没有给理由）'}</p>
      <p className='mt-1.5 break-all font-mono text-[10px] text-muted-foreground'>{result.raw}</p>
      <p className='mt-1 text-[11px] leading-relaxed text-muted-foreground'>
        失败只影响这一篇（留 pending 进人工队列）——AI 挂了不能挡住发帖。
      </p>
    </div>
  );
}

/**
 * 连通测试失败的**就地**回执（D12）。四档各一句实话 —— 缺 key / 401 / 超时 / 500 是四种不同的处理动作，
 * 一句「测试失败」等于让管理员自己猜。后端原话跟着一起显示：界面上的结论要能被后端日志对上。
 */
export function TestFail({ failure }: { failure: AiTestFailure }) {
  const danger = failure.kind === 'auth' || failure.kind === 'no_key';
  return (
    <div
      data-testid='ai-test-fail'
      role='alert'
      className={'rounded-md border px-2 py-2 ' + (danger ? 'border-destructive/40 bg-destructive/8' : 'border-border bg-muted/50')}
    >
      <span className='flex flex-wrap items-center gap-1.5'>
        <AlertTriangle size={14} aria-hidden className={danger ? 'text-destructive' : 'text-muted-foreground'} />
        <Pill tone={danger ? 'danger' : 'warn'}>{failure.label}</Pill>
        <span className='text-[12px] text-foreground'>{failure.message}</span>
      </span>
      <p className='mt-1 text-[11px] leading-relaxed text-muted-foreground'>
        失败只影响这一篇（留 pending 进人工队列）——<b>AI 挂了不能挡住发帖</b>。
      </p>
    </div>
  );
}

/**
 * 连通测试的**样例编辑器**（D33②③）：样例要看得见、改得动，且改完**真的**发这一段。
 *
 * 为什么是「临时覆盖」而不是持久化：样例是**排查用的输入**，不是配置。持久化要给它加一列 + 一条迁移，
 * 而它下一次排查（换个边界、换种语言）就该被换掉 —— 存下来的版本反而会让下一个人以为「这就是线上在发的」。
 * 代价写在界面上：刷新页面回到默认样例。默认样例本身也**不在前端写死**，它来自配置回执的 probe_sample。
 */
export function ProbeEditor({ value, defaultValue, onChange, onReset, busy }: {
  value: string;
  defaultValue: string;
  onChange: (next: string) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const edited = value !== defaultValue;
  return (
    <div className='flex flex-col gap-1'>
      <Input
        label='这一段就是发给模型的 user 样例（可改，改了立刻用新的一段）'
        multiline
        rows={3}
        inputClassName='!h-[76px]'
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        data-testid='ai-probe-sample'
      />
      <Toolbar>
        <Pill tone={edited ? 'warn' : 'neutral'}>{edited ? '已临时改动（只影响这台浏览器上的下一次测试）' : '默认样例 · 服务端给的'}</Pill>
        {edited ? (
          <Button inline={false} height={ControlsHeight.S} icon={icon16(RotateCcw)} disabled={busy} onClick={onReset}>
            恢复默认样例
          </Button>
        ) : null}
        <DisabledReason>不落库：样例存下来只会让下一个人以为「线上就在发这一段」</DisabledReason>
      </Toolbar>
    </div>
  );
}

/** 把失败粗分类成「鉴权」与「网络 / 超时」：三种回执要一眼分得开。 */
function kindOf(text: string): 'danger' | 'warn' {
  return /401|403|auth|key|鉴权|invalid|unauthorized/i.test(text) ? 'danger' : 'warn';
}


import type { ReactNode } from 'react';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { imagePath } from '@/lib/url';
import type { AiPayloadImage, AiPayloadView } from '@/lib/api/admin';
import { KV, Pill } from '../bits';

// D33①③：「**真正发给模型的那一份**」的唯一渲染处。
//
// 这一块**只渲染后端 POST /admin/ai/payload 的回执**，一个字都不自己拼：
// system / user 三段是 aireview/preview.go（assemblePrompt + userText）产出的，真判定走的是同一段代码。
// 前端再拼一份就是第二份真源 —— 两边漂一个换行、少一个「正文：」，界面上的预览就成了一句好听的假话。
//
// 为什么分段画而不是画一整段 user：脚本没法把「哪一段是标题」安全地标出来（正文里什么字符都可能有），
// 而后端把 user 拆成 prefix / title / body 三段、拼起来与真发出去的**逐字相等**。所以这里就是三段。

/** 一块文本（system / user 的每一段）：等宽、可滚、**不折行显示 NUL 之类看不见的东西**。 */
function TextBlock({ label, text, tone = 'plain', testId }: {
  label: string;
  text: string;
  tone?: 'plain' | 'accent';
  testId?: string;
}) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground'>
        <Pill tone={tone === 'accent' ? 'warn' : 'neutral'}>{label}</Pill>
        <span>{[...text].length} 字</span>
      </span>
      <pre
        data-testid={testId}
        className='m-0 max-h-[220px] overflow-auto rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground'
      >
        {text || '（空）'}
      </pre>
    </div>
  );
}

/** 一张配图的**下场**：发出去 / 没发（note 说为什么）。
 *  hash 走 imagePath 当 src —— 这条路径就是模型数据 URL 的来源（media 的 /img/{hash}），
 *  所以「图在这里长什么样」与「发给模型的是哪张」是同一张图，不是两张。 */
function ImageRow({ img }: { img: AiPayloadImage }) {
  return (
    <div data-testid='ai-payload-image' className='flex items-start gap-2 rounded-sm border border-border p-1.5'>
      <img
        src={imagePath('/img/' + img.hash)}
        alt={'配图 ' + (img.position + 1)}
        className='h-12 w-16 shrink-0 rounded-[3px] border border-border object-cover'
      />
      <span className='min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground'>
        <span className='flex flex-wrap items-center gap-1.5'>
          <Pill tone={img.sent ? 'ok' : 'danger'}>{img.sent ? '会发给模型' : '不发给模型'}</Pill>
          <span className='text-foreground'>{'第 ' + (img.position + 1) + ' 张 · ' + img.floor + ' 楼'}</span>
          <span>{img.mime + ' · ' + kb(img.bytes)}</span>
        </span>

        {img.note ? <span className='mt-0.5 block text-destructive'>{img.note}</span> : null}
        <span className='mt-0.5 block break-all font-mono text-[10px]'>{img.hash}</span>
      </span>
    </div>
  );
}

/** 「为什么只有 N 张 / 有没有图读不到」—— 上限与计数摆在图上，不用管理员去猜。 */
function ImageHeadline({ p }: { p: AiPayloadView }) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <ImageIcon size={13} aria-hidden className='text-muted-foreground' />
        <Pill tone={p.image_count > 0 ? 'ok' : 'neutral'}>{'这次判 ' + p.image_count + ' 张图'}</Pill>
        {p.image_skipped > 0 ? <Pill tone='danger'>{'没发 ' + p.image_skipped + ' 张'}</Pill> : null}
        <span className='text-[11px] text-muted-foreground'>
          {'上限 ' + p.image_limit + ' 张 / 单张 ' + mb(p.image_max_bytes) + '；已发 ' + kb(p.image_bytes)}
        </span>
      </span>
      {p.image_attachment_count === 0 ? (
        <p className='text-[11px] leading-relaxed text-muted-foreground'>
          这条帖子<b>没有配图</b>，所以模型只收到上面的文本
          {p.has_image_markdown ? '（正文里那句图片 Markdown 只是字面量，不是图）' : ''}。
        </p>
      ) : null}
      {p.image_read_failed ? (
        <p data-testid='ai-payload-read-failed' role='alert' className='flex items-start gap-1 rounded-sm border border-destructive/40 bg-destructive/8 px-2 py-1 text-[11px] leading-relaxed text-foreground'>
          <AlertTriangle size={13} aria-hidden className='mt-0.5 shrink-0 text-destructive' />
          <span>有配图<b>读不到字节</b>：这次调用会转人工复核（<b>不是</b>判违规，也不会让帖子失败）。修好图片再测一次。</span>
        </p>
      ) : null}
      {p.images.length > 0 ? (
        <div className='mt-0.5 flex flex-col gap-1.5'>
          {p.images.map((img) => <ImageRow key={img.hash + ':' + img.position} img={img} />)}
        </div>
      ) : null}
    </div>
  );
}

/** 整份 payload：两段文本 + 图片清单 + 这次调用带的参数。**没有 actions**：它只读不写。 */
export function PayloadBlock({ payload, error, testId = 'ai-payload' }: {
  payload: AiPayloadView | null;
  error?: ReactNode;
  testId?: string;
}) {
  if (error) return <>{error}</>;
  if (!payload) {
    return <p className='text-[12px] text-muted-foreground'>正在向服务端要「将要发送的那一份」…</p>;
  }
  return (
    <div data-testid={testId} className='flex flex-col gap-2'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <Pill tone='outline'>{payload.source === 'probe' ? '连通测试样例' : '真帖子'}</Pill>
        {payload.source === 'topic' ? <Pill tone={payload.trigger === 'report' ? 'warn' : 'neutral'}>{payload.trigger === 'report' ? '举报复核 prompt_report' : '新建帖 prompt'}</Pill> : null}
        {payload.trigger === 'report' ? <Pill tone='warn'>{'未处理举报 ' + payload.open_reports}</Pill> : null}
        <span className='text-[11px] text-muted-foreground'>
          {'模型 ' + (payload.model || '—') + ' · 输出上限 ' + payload.max_output_tokens + ' · ' + (payload.strict_mode ? 'strict schema' : '非 strict') + ' · temperature 0'}
        </span>
      </span>

      <TextBlock label='system（提示词）' text={payload.system} testId='ai-payload-system' />
      {payload.source === 'probe' ? (
        <TextBlock label='user（这一段就是样例本身）' text={payload.user_text} testId='ai-payload-user' />
      ) : (
        <div className='flex flex-col gap-1.5'>
          {payload.user_prefix ? <TextBlock label='user · 举报复核前缀（服务端加的，不是作者写的）' text={payload.user_prefix} tone='accent' testId='ai-payload-prefix' /> : null}
          <TextBlock label='user · 标题' text={payload.user_title} testId='ai-payload-title' />
          <TextBlock label='user · 正文' text={payload.user_body} testId='ai-payload-body' />
          <p className='text-[11px] leading-relaxed text-muted-foreground'>
            这三段拼起来（前缀 + 标题 + 空行 + 正文）就是真发出去的那一条 user 消息，<b>逐字相同</b>
            （后端有用例拿假外呼收到的原文比）。
          </p>
        </div>
      )}

      <ImageHeadline p={payload} />

      <KV k='工具 tool_name' v={payload.tool_name} hint='模型必须调用它提交结论（strict 模式下 schema 校验）' />
      <KV k='categories 值域' v={payload.categories.join(' / ')} />
      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        这是<b>组装出来的那一份</b>（dry-run）：本页不会真的外呼。要真发一次看回执，用下面的按钮。
      </p>
    </div>
  );
}

function kb(n: number): string { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
function mb(n: number): string { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(0) + ' MB' : Math.round(n / 1024) + ' KB'; }

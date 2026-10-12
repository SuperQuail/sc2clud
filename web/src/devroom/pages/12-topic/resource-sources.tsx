import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Archive, CheckCircle2, CloudDownload, ExternalLink, GitBranch, KeyRound, ShieldCheck } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { TopicSource } from './types';

// 资源帖的下载来源列表。业务意图：**「从哪下」和「还有没有人维护」是两件事**，
// 所以每一行左边是来源（网盘 / GitHub），右边是维护状态；两者用同一行的左右两端表达，不并成一句话。
// 302 转链按钮走 /api/v1/... 的 go 端点（后端方案 §21.2 的 assets/go 同款形状），前端不暴露真实直链。
export function ResourceSources({ sources }: { sources: TopicSource[] }) {
  if (sources.length === 0) {
    return (
      <section className='flex flex-col gap-2 rounded-lg border border-dashed border-border p-4'>
        <span className='text-[13px] font-medium text-foreground'>还没有可下载的来源</span>
        <span className='text-[12px] text-muted-foreground'>
          作者还没上传本体。遇到「链接失效 / 需要补档」点上面的反馈按钮提一条，作者会收到通知。
        </span>
      </section>
    );
  }
  return (
    <section className='flex flex-col gap-2'>
      <h2 className='flex items-center gap-2 text-[13px] font-semibold text-foreground'>
        <CloudDownload aria-hidden className='size-4 text-muted-foreground' />
        下载来源
        <span className='text-[12px] font-normal text-muted-foreground'>共 {sources.length} 个 · 失效请点上面的反馈按钮</span>
      </h2>
      <ul className='flex flex-col gap-2'>
        {sources.map((s) => (
          <li
            key={s.id}
            className='flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center'
          >
            <span className='flex min-w-0 flex-1 flex-col gap-1'>
              <span className='flex flex-wrap items-center gap-2'>
                <ProviderTag provider={s.provider} />
                <span className='min-w-0 truncate text-[13px] font-medium text-foreground'>{s.label}</span>
              </span>
              <span className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground'>
                {s.extraction_code ? (
                  <span className='inline-flex items-center gap-1'>
                    <KeyRound aria-hidden className='size-3' />
                    提取码 <span className='font-mono tabular-nums text-foreground'>{s.extraction_code}</span>
                  </span>
                ) : (
                  <span>无需提取码</span>
                )}
                <span className='tabular-nums'>{s.size}</span>
                <span className='tabular-nums'>核对于 {s.verified_at}</span>
              </span>
            </span>
            <span className='flex shrink-0 items-center gap-3'>
              <UpkeepFlag upkeep={s.upkeep} />
              <Button
                primary
                icon={icon16(ExternalLink)}
                href={s.go_path}
                title='由服务端记一次计数后 302 跳转到真实地址'
              >
                转链下载
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProviderTag({ provider }: { provider: TopicSource['provider'] }) {
  const netdisk = provider === 'netdisk';
  return (
    <span className='inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-border'>
      {netdisk ? <CloudDownload aria-hidden className='size-3' /> : <GitBranch aria-hidden className='size-3' />}
      {netdisk ? '网盘' : 'GitHub'}
    </span>
  );
}

function UpkeepFlag({ upkeep }: { upkeep: TopicSource['upkeep'] }) {
  if (upkeep === 'active') {
    return (
      <span className='inline-flex items-center gap-1 text-[12px] text-muted-foreground'>
        <CheckCircle2 aria-hidden className='size-3.5 text-primary' />
        维护中
      </span>
    );
  }
  return (
    <span className='inline-flex items-center gap-1 text-[12px] text-muted-foreground'>
      <Archive aria-hidden className='size-3.5' />
      已归档
    </span>
  );
}

/** 帖子级的维护状态说明（放在来源列表下面一行） */
export function UpkeepNote({ updatedAt }: { updatedAt: string }) {
  return (
    <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
      <ShieldCheck aria-hidden className='size-3.5' />
      作者最后更新于 {updatedAt}；资源本体由第三方托管，本站只提供转链与计数。
    </p>
  );
}

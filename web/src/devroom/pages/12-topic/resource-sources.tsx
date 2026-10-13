import { Archive, CheckCircle2, CloudDownload, HardDrive, Box, FileArchive, Cloud, Mountain, Globe, GitBranch, KeyRound, Link2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TopicSource } from './types';
import { protoTitle } from '@/devroom/room-links';

// 资源帖的下载来源：mcmod.cn 那种**一排网站 logo**，不是一个来源一行横条。
// 为什么改：原来每行左边一个「网盘/GitHub」方块标签 + 右边一个「转链下载」按钮，
// 用户得先读懂控件才知道点哪里；logo 是唯一需要认的东西，点它直接进网页。
// 302 仍走 /api/v1/.../go（后端方案 §21.2 assets/go 同款形状），前端不暴露真实网盘直链。
// 「还有没有人维护」是独立信息，原来在行右端，现在弱化到每列底部一行小字。

/** 站点表：**开放映射**（key 是 provider 字符串，不是联合类型）——加新站点只加一行，不改这里的分支 */
const SOURCE_SITE: Record<string, { label: string; Icon: LucideIcon }> = {
  netdisk: { label: '网盘', Icon: CloudDownload },
  github: { label: 'GitHub', Icon: GitBranch },
  baidu: { label: '百度网盘', Icon: CloudDownload },
  aliyun: { label: '阿里云盘', Icon: HardDrive },
  quark: { label: '夸克网盘', Icon: Box },
  lanzou: { label: '蓝奏云盘', Icon: FileArchive },
  onedrive: { label: 'OneDrive', Icon: Cloud },
  mega: { label: 'MEGA', Icon: Mountain },
  website: { label: '官方网站', Icon: Globe },
  other: { label: '其他', Icon: Link2 },
};

/** 查不到的 provider 一律回落到 other 的图标 + 来源自己的 label，不用 if/else 猜 */
function siteOf(s: TopicSource): { label: string; Icon: LucideIcon } {
  const key = s.provider as string;
  return SOURCE_SITE[key] ?? { ...SOURCE_SITE.other!, label: s.label };
}

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
        <span className='text-[12px] font-normal text-muted-foreground'>共 {sources.length} 个 · 点图标直接进网页</span>
      </h2>
      <ul className='flex flex-wrap items-stretch gap-x-2 gap-y-3'>
        {sources.map((s) => (
          <SourceTile key={s.id} source={s} />
        ))}
      </ul>
    </section>
  );
}

// 一列 = 圆形 logo + 站点名 + 弱化元信息（大小 / 维护状态 / 提取码）。
// 整个 logo 就是一个 <a href={go_path}>：点下去由服务端计数后 302 到真实地址，前端不拼外链。
// 站点名不放在圆里——中文站名比图标宽得多，塞进圆圈就只能缩到 9px。
// 高度用上对齐（items-start + 内容贴底）：一列多一行提取码时，圆不会被顶下去。
function SourceTile({ source }: { source: TopicSource }) {
  const site = siteOf(source);
  const { Icon } = site;
  return (
    <li className='flex w-[116px] flex-col items-center gap-1.5 text-center'>
      {/* go_path 是服务端转链端点（§21.2 的 assets/go 同款）：房间里没有这个端点，
          点 <a href> 会走到房间外（/dev/api/...）→ 改成不可导航，并把原因写在 title 里。 */}
      <span
        aria-disabled='true'
        title={protoTitle('下载转链端点') + ' · ' + site.label + ' · ' + source.label}
        className='grid size-11 shrink-0 cursor-not-allowed place-items-center rounded-full bg-card text-muted-foreground outline-none ring-1 ring-border'
      >
        <Icon aria-hidden className='size-6' />
        <span className='sr-only'>{'未做：打开 ' + site.label + '：' + source.label}</span>
      </span>
      <span className='w-full truncate text-[12px] font-medium text-foreground' title={source.label}>
        {site.label}
      </span>
      <span className='mt-auto flex w-full flex-col items-center text-[11px] leading-4 text-muted-foreground'>
        <span className='inline-flex items-center gap-1 tabular-nums' title={'最后核对于 ' + source.verified_at}>
          {source.size}
          <Middot />
          <UpkeepFlag upkeep={source.upkeep} checkedAt={source.verified_at} />
        </span>
        {/* 没有提取码的列也保留第二行（只是空着）：否则同一排里有的列两行、有的一行，圆就不齐 */}
        <span className='flex h-4 items-center'>
          {source.extraction_code ? (
            <>
              <KeyRound aria-hidden className='size-3 shrink-0' />
              <span className='ml-1'>
                提取码 <span className='font-mono tabular-nums text-foreground'>{source.extraction_code}</span>
              </span>
            </>
          ) : null}
        </span>
      </span>
    </li>
  );
}

function Middot() {
  return <span aria-hidden>·</span>;
}

function UpkeepFlag({ upkeep, checkedAt }: { upkeep: TopicSource['upkeep']; checkedAt: string }) {
  if (upkeep === 'active') {
    return (
      <span className='inline-flex items-center gap-0.5' title={'最后核对于 ' + checkedAt}>
        <CheckCircle2 aria-hidden className='size-3 shrink-0 text-primary' />
        维护中
      </span>
    );
  }
  return (
    <span className='inline-flex items-center gap-0.5' title={'已归档 · 最后核对于 ' + checkedAt}>
      <Archive aria-hidden className='size-3 shrink-0' />
      已归档
    </span>
  );
}

/** 帖子级的维护状态说明（放在来源列表下面一行） */
export function UpkeepNote({ updatedAt }: { updatedAt: string }) {
  return (
    <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
      <ShieldCheck aria-hidden className='size-3.5 shrink-0' />
      作者最后更新于 {updatedAt}；资源本体由第三方托管，本站只提供转链与计数。
    </p>
  );
}
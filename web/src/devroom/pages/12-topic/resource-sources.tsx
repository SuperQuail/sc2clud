import { Archive, CheckCircle2, CloudDownload, HardDrive, Box, FileArchive, Cloud, Mountain, Globe, GitBranch, KeyRound, Link2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TopicSource } from './types';
import { protoTitle } from '@/devroom/room-links';

// 资源帖的下载来源：mcmod.cn 那种**一排网站 logo**，不是一个来源一行横条。
// 为什么改：原来每行左边一个「网盘/GitHub」方块标签 + 右边一个「转链下载」按钮，
// 用户得先读懂控件才知道点哪里；logo 是唯一需要认的东西，点它直接进网页。
// 302 仍走 /api/v1/.../go（后端方案 §21.2 assets/go 同款形状），前端不暴露真实网盘直链。
// 「还有没有人维护」是独立信息，原来在行右端，现在弱化到每列底部一行小字。

/** 站点表：**开放映射**（key 是 provider 字符串，不是联合类型）——加新站点只加一行，不改这里的分支。
 *  key 就是后端与 lib/api/forum 的 SOURCE_PROVIDERS 词表（12 个）：多一个少一个都会在真站上显示成「其他」。
 *  netdisk 是老站词，只在房间里还在用（保留一行，免得房间那张图变成「其他」）。 */
const SOURCE_SITE: Record<string, { label: string; Icon: LucideIcon }> = {
  netdisk: { label: '网盘', Icon: CloudDownload },
  github: { label: 'GitHub', Icon: GitBranch },
  gitee: { label: 'Gitee', Icon: GitBranch },
  baidu: { label: '百度网盘', Icon: CloudDownload },
  aliyun: { label: '阿里云盘', Icon: HardDrive },
  quark: { label: '夸克网盘', Icon: Box },
  lanzou: { label: '蓝奏云盘', Icon: FileArchive },
  pan123: { label: '123 云盘', Icon: CloudDownload },
  weiyun: { label: '腾讯微云', Icon: Cloud },
  onedrive: { label: 'OneDrive', Icon: Cloud },
  mega: { label: 'MEGA', Icon: Mountain },
  website: { label: '官方网站', Icon: Globe },
  other: { label: '其他', Icon: Link2 },
};

/** 站点身份只管图标；行名在 SourceRow 里定（label 优先，见 D60） */
function siteOf(s: TopicSource): { label: string; Icon: LucideIcon } {
  return SOURCE_SITE[s.provider as string] ?? SOURCE_SITE.other!;
}

/** 没 label 时用链接的主机名让这条源可辨认（摘不出主机就空串，不硬猜） */
function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// 一行 = 站点图标 + 站点名 + 来源名 + 提取码 + 维护状态。
// **为什么是紧凑一行而不是一排圆形 logo**（D4，2026-10-14 用户实测）：原来一列 116px 的方块阵占掉
// 三行高度、还得让人先读懂控件；资源帖的读者要的是「点哪、提取码是多少」，一行就够。
// 链接版（linked）整行是一个 <a href={go_path}>：点下去由服务端计数后 302 到真实地址，前端不拼外链；
// **必须 target=_blank rel=noopener** —— 转链会把当前页带到网盘去，读者回来时帖子就没了（D4 第二条）。
// 房间（/dev/devroom/）没有这个端点，点它会走到房间外 —— 所以房间里传 false，渲染成不可点的行（原因写在 title）。
export function ResourceSources({ sources, linked = false }: { sources: TopicSource[]; linked?: boolean }) {
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
    <section data-testid='topic-sources' className='flex flex-col gap-2'>
      <h2 className='flex items-center gap-2 text-[13px] font-semibold text-foreground'>
        <CloudDownload aria-hidden className='size-4 text-muted-foreground' />
        下载来源
        <span className='text-[12px] font-normal text-muted-foreground'>共 {sources.length} 个 · 点名称新标签页打开</span>
      </h2>
      <ul className='flex flex-col gap-1'>
        {sources.map((s) => (
          <SourceRow key={s.id} source={s} linked={linked} />
        ))}
      </ul>
    </section>
  );
}

function SourceRow({ source, linked }: { source: TopicSource; linked: boolean }) {
  const site = siteOf(source);
  const { Icon } = site;
  // 一行共用同一套 class：链接版是可聚焦的 <a>（带 hover 与焦点环），房间版是 aria-disabled 的行
  const row =
    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left ring-1 ring-border outline-none';
  // D60（2026-10-15 用户实测）：topic_sources.label 就是作者写的显示名，行的主名**优先用它**；
  // 没写的时候回落站点名。两格都没字（「其他」+ 空 label）的行谁也认不出 —— 那时把原始链接的
  // 主机名当注脚摆出来（不猜名字，只摆事实）。
  const name = source.label.trim() || site.label;
  const footnote = source.label.trim() ? site.label : hostOf(source.url);
  const inner = (
    <>
      <Icon aria-hidden className='size-4 shrink-0 text-muted-foreground' />
      <span className='min-w-0 flex-1 truncate text-[12px] font-medium text-foreground' title={name}>
        {name}
      </span>
      {footnote ? (
        <span className='hidden shrink-0 text-[11px] text-muted-foreground sm:inline' title={source.url}>
          {footnote}
        </span>
      ) : null}
      {source.extraction_code ? (
        <span className='inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground'>
          <KeyRound aria-hidden className='size-3 shrink-0' />
          提取码 <span className='font-mono tabular-nums text-foreground'>{source.extraction_code}</span>
        </span>
      ) : null}
      <span className='hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex'>
        {source.size}
        <Middot />
        <UpkeepFlag upkeep={source.upkeep} checkedAt={source.verified_at} />
      </span>
    </>
  );
  if (!linked) {
    return (
      <li
        aria-disabled='true'
        title={protoTitle('下载转链端点') + ' · ' + name}
        className={row + ' cursor-not-allowed'}
      >
        {inner}
        <span className='sr-only'>{'未做：打开 ' + name}</span>
      </li>
    );
  }
  return (
    <li className='flex'>
      <a
        href={source.go_path}
        // 新标签页：点下去是服务端 302 到网盘/GitHub，当前页不该被带走
        target='_blank'
        rel='noopener'
        title={'在新标签页打开 ' + name}
        className={row + ' hover:ring-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'}
      >
        {inner}
        <span className='sr-only'>{'（新标签页）打开 ' + name}</span>
      </a>
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
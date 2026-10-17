import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Download, History } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { formatTime } from '@/lib/format';
import { PAGE_LIMIT } from '@/lib/api/paging';
import { isApiError } from '@/lib/api/errors';
import { Markdown } from '@/ui/markdown';
import { fetchLatestRelease, fetchReleases, formatBytes, type Release, type ReleaseChannel } from '@/lib/api/release';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 启动器下载（GET /launcher/latest + /launcher/releases + /launcher/assets/{id}/go）。
//
// 2026-10-13：这一页原先是个占位页（「启动器下载还没接后端」），而三条端点在后端一直都在
// （release.Handler.Register），前端连函数都没有。本站**不承载产物字节**：url 是外部直链，
// 点下载走 302 转链（release/service.go 的原话），所以这里的按钮 href 是 go 端点而不是 url。
//
// 通道只有 stable / beta（迁移里的 ck_releases_channel）；Latest 不传按 stable。
// 没有已发布的版本时**如实说「还没有发布」** —— 不用假数据糊一屏。

const CHANNELS: ReadonlyArray<{ key: ReleaseChannel; label: string }> = [
  { key: 'stable', label: '稳定版' },
  { key: 'beta', label: '测试版' },
];

/** go 端点：站内路径，必须过 appPath（同一份产物要在 / 与 /dev/ 下都能用）。 */
function goHref(assetId: string): string {
  return appPath('api/v1/launcher/assets/' + encodeURIComponent(assetId) + '/go');
}

function AssetRow({ asset }: { asset: { id: string; platform: string; arch: string; size: number; sha256: string; download_count: number } }) {
  return (
    <li className='flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0'>
      <div className='flex min-w-0 flex-1 flex-col'>
        <span className='text-[14px] font-medium text-foreground'>
          {asset.platform} · {asset.arch}
        </span>
        <span className='truncate text-[12px] text-muted-foreground'>
          {formatBytes(asset.size)}
          {asset.sha256 ? ' · SHA256 ' + asset.sha256.slice(0, 12) + '…' : ''}
          {asset.download_count ? ' · 已下载 ' + asset.download_count + ' 次' : ''}
        </span>
      </div>
      <Button
        data-testid={'download-asset-' + asset.id}
        primary
        inline={false}
        height={ControlsHeight.S}
        icon={icon16(Download)}
        href={goHref(asset.id)}
      >
        下载
      </Button>
    </li>
  );
}

function ReleaseBlock({ release }: { release: Release }) {
  return (
    <section className='flex flex-col overflow-hidden rounded-lg border border-border bg-card'>
      <header className='flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-3'>
        <h2 className='text-[16px] font-semibold text-foreground'>{release.version}</h2>
        <span className='text-[12px] text-muted-foreground'>
          {release.channel}
          {release.published_at ? ' · 发布于 ' + formatTime(release.published_at) : ''}
        </span>
      </header>
      {release.notes_html ? (
        <div className='border-b border-border px-4 py-3 text-[13px] text-foreground'>
          <Markdown html={release.notes_html} className='prose prose-sm max-w-none' />
        </div>
      ) : null}
      {release.assets.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[13px] text-muted-foreground'>这个版本还没有挂任何产物。</p>
      ) : (
        <ul className='m-0 flex list-none flex-col p-0'>
          {release.assets.map((a) => (
            <AssetRow key={a.id} asset={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DownloadPage() {
  const [params, setParams] = useSearchParams();
  const channel: ReleaseChannel = params.get('channel') === 'beta' ? 'beta' : 'stable';

  // retry: false —— 「还没有发布」是 404，重试三次只是让空态晚 3 秒出现。
  const latest = useQuery({
    queryKey: qk.releaseLatest(channel),
    queryFn: ({ signal }) => fetchLatestRelease(channel, signal),
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: [...qk.releases(), channel],
    queryFn: ({ pageParam, signal }) => fetchReleases({ cursor: pageParam }, channel, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });

  const past: Release[] = history.data?.pages.flatMap((p) => p.items) ?? [];
  // 最新版通常也在历史列表里（同一个 version 会出现两次）：历史里排掉它，别让人以为有两个版本。
  const older = latest.data ? past.filter((r) => r.id !== latest.data?.id) : past;
  const notPublished = latest.isError && isApiError(latest.error) && latest.error.status === 404;

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader
        title='启动器下载'
        description='本站不存产物字节，点下载会跳到对应的外部直链（转链这一步才计入下载数）。'
        actions={
          <ButtonSet>
            {CHANNELS.map((c) => (
              <Button
                key={c.key}
                data-testid={'download-channel-' + c.key}
                primary={c.key === channel}
                ghost={c.key !== channel}
                active={c.key === channel}
                inline={false}
                height={ControlsHeight.S}
                onClick={() => setParams(c.key === 'stable' ? {} : { channel: c.key }, { replace: true })}
              >
                {c.label}
              </Button>
            ))}
          </ButtonSet>
        }
      />

      {latest.isPending ? (
        <Loading what='最新版本' />
      ) : latest.isError ? (
        notPublished ? (
          <Empty
            icon={Download}
            title={'还没有发布' + (channel === 'stable' ? '稳定版' : '测试版')}
            hint='发布在这里的版本由管理员录入（版本号 + 各平台产物 + 外部直链）。没有已发布版本时这一页就是空的 —— 不拿旧版本或假链接凑数。'
          />
        ) : (
          <ErrorState what='最新版本' error={latest.error} onRetry={() => void latest.refetch()} />
        )
      ) : (
        <ReleaseBlock release={latest.data} />
      )}

      <section className='flex flex-col gap-2'>
        <h2 className='m-0 flex items-center gap-2 text-[15px] font-semibold text-foreground'>
          <History aria-hidden className='size-4 text-muted-foreground' />
          历史版本
        </h2>
        {history.isPending ? (
          <Loading what='历史版本' className='py-8' />
        ) : history.isError ? (
          <ErrorState what='历史版本' error={history.error} onRetry={() => void history.refetch()} />
        ) : older.length === 0 ? (
          <p className='m-0 text-[13px] text-muted-foreground'>
            {latest.data ? '这是目前唯一发布过的版本。' : '还没有发布过任何版本。'}
          </p>
        ) : (
          <>
            {older.map((r) => (
              <ReleaseBlock key={r.id} release={r} />
            ))}
            {history.hasNextPage ? (
              <div className='flex flex-col items-center gap-1.5'>
                <Button loader={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
                  {history.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
                <span className='text-[11px] text-muted-foreground'>每页 {PAGE_LIMIT} 条 · 按游标翻页（不是页码）</span>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

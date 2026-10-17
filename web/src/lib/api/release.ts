import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';
import type { Paged } from './forum';

// 启动器下载索引（v2 §21.2 的 launcher 段）。本站**不承载产物字节**：asset.url 是外部直链，
// 点下载走 /launcher/assets/{id}/go 的 302（计数在那一步加，release/service.go 的原话）。
//
// 2026-10-13：三条端点后端一直都在（release.Handler.Register），前端没有函数 —— /download 是占位页。

export type ReleaseAsset = {
  id: string;
  platform: string;
  arch: string;
  url: string;
  size: number;
  sha256: string;
  download_count: number;
};

export type Release = {
  id: string;
  version: string;
  channel: string;
  notes_md: string;
  notes_html: string;
  status: string;
  published_at: string | null;
  created_at: string;
  assets: ReleaseAsset[];
};

/** 通道只有 stable / beta（ck_releases_channel）；不传按 stable（release.Service.Latest）。 */
export type ReleaseChannel = 'stable' | 'beta';

export function fetchLatestRelease(channel: ReleaseChannel = 'stable', signal?: AbortSignal): Promise<Release> {
  return api<Release>('launcher/latest', { query: { channel }, signal });
}

export function fetchReleases(q: PageQuery = {}, channel?: ReleaseChannel, signal?: AbortSignal): Promise<Paged<Release>> {
  return apiPage<Release>('launcher/releases', { query: { channel, ...pageQuery(q) }, signal });
}

/** 产物大小是字节数（int64）：按 KB/MB 显示，别把 12345678 直接甩给用户。 */
export function formatBytes(n: number): string {
  if (!n) return '大小未标注';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

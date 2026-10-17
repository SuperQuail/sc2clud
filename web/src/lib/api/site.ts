import { api } from './client';

// 站点域（v2 §21.2 site 段）：站点名、公告、生效中的横幅。布局壳要用它（页脚与横幅位）。
export type SiteInfo = {
  name: string;
  announcements: Array<{ id: string; title: string; body_html?: string; created_at: string }>;
  banner?: { id: string; text: string; dismissed?: boolean } | null;
};

export function fetchSite(signal?: AbortSignal): Promise<SiteInfo> {
  return api<SiteInfo>('site', { signal });
}

export function dismissBanner(id: string): Promise<void> {
  return api<void>('banners/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
}

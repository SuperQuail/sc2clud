import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchAnnouncements,
  fetchBanners,
  fetchDomains,
  fetchSiteSettings,
  saveSiteSettings,
  updateAnnouncement,
  updateBanner,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { SettingsScreen } from '@/devroom/pages/15-admin/screens/settings';

// ── 屏 i：站点设置 ────────────────────────────────────────────────────────
// 依赖 GET/PATCH /admin/site-settings、GET /admin/site-domains、
// GET/POST /admin/announcements + PATCH、GET/POST /admin/banners + PATCH（都已在，权限点 site.setting）。
// 键值目录由后端给（SettingItem），前端不维护第二张表。

export function SettingsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const settings = useQuery({ queryKey: qk.adminSiteSettings(), queryFn: ({ signal }) => fetchSiteSettings(signal) });
  const domains = useQuery({ queryKey: qk.adminDomains(), queryFn: ({ signal }) => fetchDomains(signal) });
  const announcements = useQuery({ queryKey: qk.adminAnnouncements(), queryFn: ({ signal }) => fetchAnnouncements(signal) });
  const banners = useQuery({ queryKey: qk.adminBanners(), queryFn: ({ signal }) => fetchBanners(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin'] });

  const save = useMutation({
    mutationFn: saveSiteSettings,
    onSuccess: () => { setReceipt('设置已保存（只写了改动过的键）'); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const toggleAnn = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => updateAnnouncement(v.id, { enabled: v.enabled }),
    onSuccess: (a) => { setReceipt('公告「' + a.title + '」已' + (a.enabled ? '启用' : '停用')); refresh(); },
    onError: (e) => setReceipt('公告改动失败：' + (errorLine(e) ?? '')),
  });
  const publishAnn = useMutation({
    mutationFn: (id: string) => updateAnnouncement(id, { publish: true }),
    onSuccess: (a) => { setReceipt('公告「' + a.title + '」已发布'); refresh(); },
    onError: (e) => setReceipt('发布失败：' + (errorLine(e) ?? '')),
  });
  const toggleBanner = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => updateBanner(v.id, { enabled: v.enabled }),
    onSuccess: (b) => { setReceipt('横幅已' + (b.enabled ? '启用' : '停用')); refresh(); },
    onError: (e) => setReceipt('横幅改动失败：' + (errorLine(e) ?? '')),
  });

  const err = [settings.error, domains.error, announcements.error, banners.error].find(Boolean);
  return (
    <SettingsScreen
      settings={settings.data ?? []}
      domains={domains.data ?? []}
      announcements={announcements.data ?? []}
      banners={banners.data ?? []}
      loading={settings.isPending}
      error={err ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          设置没能加载（HTTP {isApiError(err) ? err.status : 0}）：{errorLine(err)}
        </p>
      ) : null}
      canSetting={can(session.session, 'site.setting')}
      onSave={(values) => save.mutate(values)}
      onToggleAnnouncement={(id, enabled) => toggleAnn.mutate({ id, enabled })}
      onPublishAnnouncement={(id) => publishAnn.mutate(id)}
      onToggleBanner={(id, enabled) => toggleBanner.mutate({ id, enabled })}
      busy={save.isPending || toggleAnn.isPending || publishAnn.isPending || toggleBanner.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}


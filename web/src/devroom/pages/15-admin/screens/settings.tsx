import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import type { Announcement, Banner, Domain, SettingItem } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';

// 13.15 站点文案可改（site_settings 键值）+ 13.14 域名（只读）+ 公告与横幅。
//
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。
//
// 三处与旧版（mock）不同、必须照后端来的：
//   ① **键值目录是后端给的**（site/dto.go 的 SettingItem 自带 `key/label/grp/kind/options/value/hint`）
//      —— 前端不再维护一张「有哪些键、每组什么类型」的表。那张表必然与后端漂移，
//      而漂移的表现是「设置项在后台根本看不见」（老站 13 个 site_texts 键就是这么全丢的）。
//   ② `kind` 的取值由后端定：`toggle | select | multiline | text`（其余按 text 渲染）。
//      toggle 的值是字符串，这一屏按 `on/true/1` 都算开（后端写的是什么就回什么）。
//   ③ `PATCH` **只写传进来的键**（SettingsInput.values 是 map）—— 所以只发改动过的键。
//
// 域名是**只读**的：真源是配置里的 base_url（拍板 §8.11 U2），没有写端点，界面不假装能改。

const BANNER_KIND_LABEL: Record<string, string> = { info: '信息', warning: '警告', promo: '推广' };

const valuesOf = (items: SettingItem[]) => Object.fromEntries(items.map((s) => [s.key, s.value]));

export type SettingsScreenProps = {
  settings: SettingItem[];
  domains: Domain[];
  announcements: Announcement[];
  banners: Banner[];
  loading?: boolean;
  error?: ReactNode;
  canSetting: boolean;
  /** 只发改动过的键（后端 PATCH 的语义就是「出现的键才写」） */
  onSave: (values: Record<string, string>) => void;
  onToggleAnnouncement: (id: string, enabled: boolean) => void;
  onPublishAnnouncement: (id: string) => void;
  onToggleBanner: (id: string, enabled: boolean) => void;
  busy?: boolean;
  receipt?: ReactNode;
};

export function SettingsScreen({
  settings, domains, announcements, banners, loading = false, error = null,
  canSetting, onSave, onToggleAnnouncement, onPublishAnnouncement, onToggleBanner, busy = false, receipt,
}: SettingsScreenProps) {
  // 草稿与「它对应的是后端哪一版」放同一个 state：后端值一变（保存成功 / 别人改了）就整份换掉，
  // 否则旧草稿会覆盖新值 —— 那是最难查的一类丢改动。
  const serverVersion = settings.map((s) => s.key + '\u0000' + s.value).join('\u0001');
  const [form, setForm] = useState(() => ({ version: serverVersion, draft: valuesOf(settings) }));
  if (form.version !== serverVersion) setForm({ version: serverVersion, draft: valuesOf(settings) });
  const draft = form.draft;
  const setDraft = (fn: (prev: Record<string, string>) => Record<string, string>) =>
    setForm((f) => ({ ...f, draft: fn(f.draft) }));

  const dirtyKeys = settings.filter((s) => (draft[s.key] ?? s.value) !== s.value).map((s) => s.key);
  const groups = [...new Set(settings.map((s) => s.group))];

  function control(s: SettingItem) {
    const value = draft[s.key] ?? s.value;
    const bad = !canSetting || busy;
    if (s.kind === 'toggle') {
      const on = value === 'on' || value === 'true' || value === '1';
      return (
        <Toggle checked={on} disabled={bad} onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.checked ? 'on' : 'off' }))}>
          {s.label}
        </Toggle>
      );
    }
    if (s.kind === 'select') {
      const options = (s.options ?? []).map((o) => ({ key: o, label: o }));
      return (
        <Select
          type={SelectType.INPUT}
          label={s.label}
          data={options}
          selected={options.find((o) => o.key === value) ?? null}
          onSelect={(item) => { if (item) setDraft((p) => ({ ...p, [s.key]: String(item.key) })); }}
        />
      );
    }
    // 分成两支：multiline 必须是字面量，否则 Ring 的 props 联合类型推不出 onChange 的参数类型
    return s.kind === 'multiline' ? (
      <Input label={s.label} multiline rows={3} value={value} disabled={bad} onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.value }))} />
    ) : (
      <Input label={s.label} value={value} disabled={bad} onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.value }))} />
    );
  }

  const domainColumns = [
    { key: 'domain', title: '域名', track: 'minmax(200px,1.6fr)', render: (d: Domain) => <span className='font-mono text-[12px] text-foreground'>{d.domain}</span> },
    {
      key: 'use', title: '用途', track: 'minmax(200px,1.6fr)',
      render: () => <span className='text-[12px] text-muted-foreground'>Cookie / CSRF 判定基准（换域名要同步改 Cookie 与 CORS）</span>,
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='站点设置与文案'
        note='13.15：site_settings 是键值表，不用为每条文案加一列；键值目录由后端给（前端不维护第二张表）。13.14：域名只读。'
        actions={
          <ButtonSet>
            <Button disabled={!canSetting || dirtyKeys.length === 0} onClick={() => setForm((f) => ({ ...f, draft: valuesOf(settings) }))}>放弃改动</Button>
            <Button
              primary
              disabled={!canSetting || dirtyKeys.length === 0 || busy}
              onClick={() => onSave(Object.fromEntries(dirtyKeys.map((k) => [k, draft[k] ?? ''])))}
            >
              保存 {dirtyKeys.length} 项改动
            </Button>
          </ButtonSet>
        }
      />

      <StatRow>
        <Stat label='设置项' value={settings.length} />
        <Stat label='未保存' value={dirtyKeys.length} tone={dirtyKeys.length ? 'danger' : 'neutral'} hint={dirtyKeys.length ? dirtyKeys.slice(0, 3).join('、') : '全部已保存'} />
        <Stat label='公告' value={announcements.length} hint='含未发布的草稿' />
        <Stat label='横幅' value={banners.length} />
        <Stat label='域名' value={domains.length} hint='只读' />
      </StatRow>

      {!canSetting ? <GateNote perm='site.setting'>所有键值只读：本账号没有 site.setting。</GateNote> : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        {loading && settings.length === 0 ? (
          <Panel title='设置项'><p className='text-[12px] text-muted-foreground'>正在加载…</p></Panel>
        ) : null}
        {groups.map((grp) => (
          <Panel
            key={grp}
            title={grp}
            note='改动按 key 提交（PATCH /admin/site-settings，只写传进来的键）'
            actions={settings.filter((s) => s.group === grp && draft[s.key] !== s.value).length > 0 ? <Pill tone='warn'>本组有未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
          >
            <div className='flex flex-col gap-2'>
              {settings.filter((s) => s.group === grp).map((s) => (
                <div key={s.key} className='flex flex-col gap-0.5'>
                  {control(s)}
                  <span className='flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground'>
                    <code className='rounded-sm bg-muted px-1'>{s.key}</code>
                    <Pill tone='outline'>{s.kind}</Pill>
                    {s.hint}
                    {draft[s.key] !== s.value ? <Pill tone='warn'>未保存</Pill> : null}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        ))}

        <Panel title='公告（announcements）' note='同一套 site.setting 权限（§21.2）；enabled 与 published_at 是两件事'>
          <div className='flex flex-col gap-1.5'>
            {announcements.map((a) => (
              <div key={a.id} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                <span className='flex min-w-0 flex-col leading-tight'>
                  <span className='truncate text-[12px] font-medium text-foreground'>{a.title}</span>
                  <span className='text-[11px] text-muted-foreground'>
                    {a.published_at ? '发布于 ' + a.published_at.slice(0, 10) : '未发布（草稿）'} · 更新 {a.updated_at.slice(0, 10)}
                  </span>
                </span>
                <span className='flex shrink-0 items-center gap-1.5'>
                  {a.published_at ? null : (
                    <Button disabled={!canSetting || busy} onClick={() => onPublishAnnouncement(a.id)}>发布</Button>
                  )}
                  <Toggle
                    checked={a.enabled}
                    disabled={!canSetting || busy}
                    onChange={(e) => onToggleAnnouncement(a.id, e.target.checked)}
                  >
                    {a.enabled ? '启用' : '停用'}
                  </Toggle>
                </span>
              </div>
            ))}
            {announcements.length === 0 ? <p className='text-[12px] text-muted-foreground'>还没有公告。新建入口还没接（POST /admin/announcements 需要 title + body_md 的编辑表单）。</p> : null}
          </div>
        </Panel>

        <Panel title='横幅（banners）' note='roles 空 = 所有人；定向是整表替换'>
          <div className='flex flex-col gap-1.5'>
            {banners.map((b) => (
              <div key={b.id} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                <span className='flex min-w-0 flex-col leading-tight'>
                  <span className='truncate text-[12px] font-medium text-foreground'>{b.text}</span>
                  <span className='text-[11px] text-muted-foreground'>
                    {BANNER_KIND_LABEL[b.kind] ?? b.kind} · {b.roles.length > 0 ? '定向 ' + b.roles.join('、') : '所有人'}
                    {b.ends_at ? ' · 至 ' + b.ends_at.slice(0, 10) : ' · 永久'}
                  </span>
                </span>
                <Toggle checked={b.enabled} disabled={!canSetting || busy} onChange={(e) => onToggleBanner(b.id, e.target.checked)}>
                  {b.enabled ? '启用' : '停用'}
                </Toggle>
              </div>
            ))}
            {banners.length === 0 ? <p className='text-[12px] text-muted-foreground'>还没有横幅。</p> : null}
          </div>
        </Panel>

        <Panel title='域名（site_domains）' note='只读：真源是配置里的 base_url（拍板 §8.11 U2），没有写端点'>
          <DataTable
            columns={domainColumns}
            rows={domains}
            rowKey={(d) => d.domain}
            rowLabel={(d) => d.domain}
            minWidth={420}
            density='compact'
            empty='还没有登记域名'
          />
          <KV k='启动时自动登记' v='base_url 的域名会被登记' />
          <KV k='写入端点' v='没有（这一屏不假装能改）' hint='换域名要同步改 Cookie 域与 CORS' />
        </Panel>
      </div>
    </div>
  );
}

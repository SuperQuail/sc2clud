import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { DataTable } from '../data-table';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { SITE_DOMAINS, SITE_SETTINGS, type SiteDomain, type SiteSetting } from '../mock';
import { useCan } from '../mock/perms';

// 13.15 站点文案可改（site_settings 键值）+ 13.14 域名（只读：§21.2 没有域名端点）。
// 每个键值都带「未保存 / 已保存」态：改完必须显式保存，避免「以为改了其实没保存」。

const NOTICES = [
  { id: 'n_1', title: '启动器 0.7.2 发布', kind: '公告', when: '2026-10-11T02:10:00Z', state: '已发布' },
  { id: 'n_2', title: '国庆活动：战役试玩周', kind: '横幅（promo）', when: '2026-09-30T00:00:00Z', state: '已结束' },
  { id: 'n_3', title: '机房维护通知（10-20 03:00）', kind: '横幅（warning）', when: '2026-10-12T01:00:00Z', state: '生效中' },
];

export function SettingsScreen() {
  const canSetting = useCan('site.setting');
  const canSystem = useCan('system.settings');
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(SITE_SETTINGS.map((s) => [s.key, s.value])));
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries(SITE_SETTINGS.map((s) => [s.key, s.value])));

  const dirtyKeys = SITE_SETTINGS.filter((s) => draft[s.key] !== saved[s.key]).map((s) => s.key);
  const groups = [...new Set(SITE_SETTINGS.map((s) => s.grp))];

  function control(s: SiteSetting) {
    const value = draft[s.key] ?? '';
    if (s.kind === 'toggle') {
      return (
        <Toggle
          checked={value === 'on'}
          disabled={!canSetting}
          onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.checked ? 'on' : 'off' }))}
        >
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
      <Input label={s.label} multiline rows={3} value={value} disabled={!canSetting} onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.value }))} />
    ) : (
      <Input label={s.label} value={value} disabled={!canSetting} onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.value }))} />
    );
  }

  const domainColumns = [
    { key: 'domain', title: '域名', track: 'minmax(200px,1.6fr)', render: (d: SiteDomain) => <span className='font-mono text-[12px] text-foreground'>{d.domain}</span> },
    { key: 'primary', title: '角色', track: '120px', render: (d: SiteDomain) => (d.is_primary ? <Pill tone='ok'>主域名</Pill> : <Pill>别名</Pill>) },
    {
      key: 'use', title: '用途', track: 'minmax(200px,1.6fr)',
      render: (d: SiteDomain) => <span className='text-[12px] text-muted-foreground'>{d.is_primary ? 'Cookie / CSRF 判定基准（换域名要同步改 Cookie 与 CORS）' : '解析到同一实例，登录态互通'}</span>,
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='站点设置与文案'
        note='13.15：site_settings 是键值表，不用为每条文案加一列；13.14：域名表只读展示（没有端点）。'
        actions={
          <ButtonSet>
            <Button disabled={!canSetting || dirtyKeys.length === 0} onClick={() => setDraft(Object.fromEntries(SITE_SETTINGS.map((s) => [s.key, saved[s.key]!])))}>放弃改动</Button>
            <Button primary disabled={!canSetting || dirtyKeys.length === 0} onClick={() => setSaved({ ...draft })}>保存全部改动</Button>
          </ButtonSet>
        }
      />

      <StatRow>
        <Stat label='设置项' value={SITE_SETTINGS.length} />
        <Stat label='未保存' value={dirtyKeys.length} tone={dirtyKeys.length ? 'danger' : 'neutral'} hint={dirtyKeys.length ? dirtyKeys.join('、') : '全部已保存'} />
        <Stat label='公告 / 横幅' value={NOTICES.length} />
        <Stat label='域名' value={SITE_DOMAINS.length} hint='只读' />
      </StatRow>

      {!canSetting ? <GateNote perm='site.setting'>所有键值只读：本账号没有 site.setting。</GateNote> : null}

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        {groups.map((grp) => (
          <Panel
            key={grp}
            title={grp}
            note={'改动按 key 提交（PATCH /api/v1/admin/site-settings）'}
            actions={SITE_SETTINGS.filter((s) => s.grp === grp && draft[s.key] !== saved[s.key]).length > 0 ? <Pill tone='warn'>本组有未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
          >
            <div className='flex flex-col gap-2'>
              {SITE_SETTINGS.filter((s) => s.grp === grp).map((s) => (
                <div key={s.key} className='flex flex-col gap-0.5'>
                  {control(s)}
                  <span className='flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground'>
                    <code className='rounded-sm bg-muted px-1'>{s.key}</code>
                    {s.hint}
                    {draft[s.key] !== saved[s.key] ? <Pill tone='warn'>未保存</Pill> : null}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        ))}

        <Panel title='公告与横幅' note='announcements / banners：同一套 site.setting 权限（§21.2）'>
          <div className='flex flex-col gap-1.5'>
            {NOTICES.map((n) => (
              <div key={n.id} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                <span className='flex min-w-0 flex-col leading-tight'>
                  <span className='truncate text-[12px] font-medium text-foreground'>{n.title}</span>
                  <span className='text-[11px] text-muted-foreground'>{n.kind} · {n.when.slice(0, 10)}</span>
                </span>
                <Pill tone={n.state === '生效中' ? 'ok' : 'neutral'}>{n.state}</Pill>
              </div>
            ))}
          </div>
          <Toolbar className='mt-2'>
            <Button disabled={!canSetting}>发布公告</Button>
            <Button disabled={!canSetting}>新建横幅</Button>
          </Toolbar>
        </Panel>

        <Panel title='域名（site_domains）' note='只读：is_primary 由部分唯一索引保证只有一个（DB §4.9）'>
          <DataTable
            columns={domainColumns}
            rows={SITE_DOMAINS}
            rowKey={(d) => d.domain}
            rowLabel={(d) => d.domain}
            minWidth={420}
            density='compact'
            empty='还没有登记域名'
          />
          <KV k='启动时自动登记' v='base_url 的域名会被登记为 primary' />
          <KV k='写入端点' v='缺失（§21.2 没有 /admin/site-domains）' hint='见回报的后端需求' />
        </Panel>

        <Panel title='系统级配置'>
          {canSystem ? (
            <p className='text-[12px] text-muted-foreground'>debug 开关 / 主域名切换 / 备份策略（本页不重复实现）</p>
          ) : (
            <GateNote perm='system.settings'>
              「debug 开关」「切换主域名」「立即备份」不渲染：它们属 system.settings，本账号没有。
              主域名一改会同时牵动 Cookie 域与 CSRF 校验，不该由值班管理员随手点。
            </GateNote>
          )}
        </Panel>
      </div>
    </div>
  );
}
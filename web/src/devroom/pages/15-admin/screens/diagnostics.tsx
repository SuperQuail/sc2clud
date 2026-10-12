import { useState } from 'react';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { DataTable } from '../data-table';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { DIAGNOSTICS, type DiagnosticCheck } from '../mock';
import { useCan } from '../mock/perms';

// 13.12 自检面板（§21.2 GET /admin/diagnostics：site.setting **且** debug 开关打开）。
// **只读**：这里不提供任何「一键修复」——修复动作要么是迁移，要么是运维命令。

export function DiagnosticsScreen() {
  const canSetting = useCan('site.setting');
  const canSystem = useCan('system.settings');
  const [debugOn] = useState(DIAGNOSTICS.debug_enabled);

  const rows: DiagnosticCheck[] = DEBUG_ROWS();
  const failed = rows.filter((r) => !r.ok);

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='自检面板'
        note='13.12：debug 开关门控的只读结果。这里只回答「系统现在自洽吗」，不提供修改入口。'
        actions={<span className='flex items-center gap-2 text-[12px] text-muted-foreground'><Toggle checked={debugOn} disabled onChange={() => {}}>debug 开关</Toggle></span>}
      />

      <StatRow>
        <Stat label='检查项' value={rows.length} />
        <Stat label='通过' value={rows.length - failed.length} tone='info' />
        <Stat label='异常' value={failed.length} tone={failed.length ? 'danger' : 'neutral'} />
        <Stat label='版本' value={DIAGNOSTICS.version} hint={'启动于 ' + DIAGNOSTICS.started_at.slice(11, 16) + ' UTC'} />
      </StatRow>

      {!canSetting ? <GateNote perm='site.setting'>GET /admin/diagnostics 需要 site.setting：本账号没有，面板不渲染。</GateNote> : null}
      {!debugOn ? (
        <Panel title='debug 开关关闭'>
          <p className='text-[12px] text-muted-foreground'>debug 关闭时这个端点整体不可用（§21.2 要求 site.setting 且 debug 打开）；界面不应该显示上一次的缓存结果。</p>
        </Panel>
      ) : null}

      {canSetting && debugOn ? (
        <>
          <Panel
            title='自检结果'
            note='每项都对应一条会自动红的一致性检查（DB §12 / 后端 §9.8 启动自检）'
          >
            <DataTable
              columns={[
                { key: 'name', title: '检查项', track: 'minmax(170px,1.4fr)', render: (c: DiagnosticCheck) => <span className='text-[13px] font-medium text-foreground'>{c.name}</span> },
                { key: 'result', title: '结果', track: '96px', render: (c: DiagnosticCheck) => (c.ok ? <Pill tone='ok'>通过</Pill> : <Pill tone='danger'>异常</Pill>) },
                { key: 'detail', title: '详情', track: 'minmax(260px,2fr)', render: (c: DiagnosticCheck) => <span className='truncate text-[12px] text-muted-foreground'>{c.detail}</span> },
                { key: 'ms', title: '耗时', track: '76px', align: 'end' as const, sortable: true, sortValue: (c: DiagnosticCheck) => c.ms, render: (c: DiagnosticCheck) => <span className='text-[12px] text-muted-foreground'>{c.ms} ms</span> },
              ]}
              rows={rows}
              rowKey={(c) => c.name}
              rowLabel={(c) => c.name}
              minWidth={720}
              density='compact'
              empty='没有检查结果'
            />
          </Panel>

          <div className='grid items-start gap-3 lg:grid-cols-2'>
            <Panel title='异常项怎么处理' note='只读面板的边界：能看不能改'>
              {failed.length === 0 ? <p className='text-[12px] text-muted-foreground'>当前没有异常。</p> : (
                <div className='flex flex-col gap-1.5'>
                  {failed.map((f) => (
                    <div key={f.name} className='rounded-sm border border-border px-2 py-1'>
                      <div className='flex items-center gap-1.5'><Pill tone='danger'>{f.name}</Pill></div>
                      <p className='text-[11px] text-muted-foreground'>{f.detail}</p>
                      <p className='text-[11px] text-muted-foreground'>处理：{f.name === '搜索索引延迟' ? '等 search:index 任务追上，或看 jobs 表里的积压（不是在这里点按钮）' : '看服务日志与迁移记录'}</p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title='运维动作'>
              {canSystem ? (
                <p className='text-[12px] text-muted-foreground'>重建索引 / 清理缓存（系统级）</p>
              ) : (
                <GateNote perm='system.settings'>
                  「重建搜索索引」「清理图片缓存」「立即备份」不渲染：这些动作属 system.settings。
                  备份本身是 DB §8 的运维流程（pg_dump + 快照），不放在业务后台上。
                </GateNote>
              )}
              <KV k='最近备份' v={DIAGNOSTICS.checks.find((c) => c.name === '最近备份')?.detail ?? '—'} />
              <KV k='探针' v='/healthz（版本） · /readyz（真打数据库与存储）' hint='不带 /api 前缀（§21.1）' />
              <DisabledReason>面板只读：任何「修复」都不在网页上做</DisabledReason>
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}

function DEBUG_ROWS(): DiagnosticCheck[] {
  return DIAGNOSTICS.checks;
}
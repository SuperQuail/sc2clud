import type { Diagnostics } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { DisabledReason, GateNote, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';

// 13.12 自检面板（§21.2 GET /admin/diagnostics：site.setting **且** debug 开关打开）。
// **只读**：这里不提供任何「一键修复」——修复动作要么是迁移，要么是运维命令。
//
// **prop 驱动**（照其它屏）：数据由宿主给（routes/admin/diagnostics.tsx）。
// 三处照后端改：
//  ① 检查项有三态（ok / fail / **skipped**），不是布尔 ——「没查」不能显示成「通过」（那是这类面板最常见的假绿）；
//  ② debug 关闭时端点整体 **404**，所以拿不到数据时要说「关掉了」，不能渲染一张空表（空表看起来像「跑了没问题」）；
//  ③ mock 里的「重建索引 / 清理图片缓存 / 立即备份」三颗按钮**一个都不画**：后端没有这些端点，
//     而 system.settings 这个权限点在后端 authz 里**根本不存在**（authz.go 的常量表里没有它）。
export type DiagnosticsProps = {
  data: Diagnostics | null;
  loading?: boolean;
  /** 拿不到时：404 **common.not_found** 在这里是预期内的（debug 关闭），不是「系统坏了」 */
  error?: { message: string; status: number; code: string } | null;
  canSetting: boolean;
};

/**
 * debug 关闭时后端给的就是 404 **common.not_found**（C3 的设计，不是坏）—— 判据只能是错误**码**：
 * 状态码 404 不够，路由真的不在也是 404（common.route_not_found），那一档必须如实报错、不能拿「关掉了」糊过去。
 */
export function isDebugOff(error: { code: string } | null | undefined): boolean {
  return error?.code === 'common.not_found';
}

type Check = Diagnostics['checks'][number];

export function DiagnosticsScreen({ data, loading = false, error = null, canSetting }: DiagnosticsProps) {
  // debug 关闭这一档**只留一句说明**（D13）：原来画的 404 红卡 + 一排「—」的空指标格，
  // 给人看到的是「面板坏了」，而它其实是「这扇门本来就关着」。
  if (isDebugOff(error)) {
    return (
      <div className='flex flex-col gap-3'>
        <ScreenHead title='自检面板' note='13.12：debug 开关门控的只读结果。这里只回答「系统现在自洽吗」，不提供修改入口。' />
        <Panel title='debug 开关关闭' data-testid='diag-debug-off'>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            自检面板默认关闭，需在后端打开 debug 开关。开启之前这里不显示任何检查结果 ——
            后端这时回的就是 404 common.not_found，不是「跑了没问题」，也不是系统坏了。
          </p>
        </Panel>
      </div>
    );
  }

  const rows = data?.checks ?? [];
  const failed = rows.filter((r) => r.status === 'fail');
  const skipped = rows.filter((r) => r.status === 'skipped');

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='自检面板'
        note='13.12：debug 开关门控的只读结果。这里只回答「系统现在自洽吗」，不提供修改入口。'
      />

      {/* 指标格只在**真拿到结果**时画：拿不到时那一排「—」正是 D13 要消灭的东西（它看着像坏了） */}
      {data ? <StatRow data-testid='diag-stats'>
        <Stat label='检查项' value={data.total} />
        <Stat label='通过' value={rows.filter((r) => r.status === 'ok').length} tone='info' />
        <Stat label='异常' value={data.failed} tone={failed.length ? 'danger' : 'neutral'} />
        <Stat label='没查（skipped）' value={skipped.length} hint='与「通过」是两件事：没查的显示成通过就是假绿' />
        <Stat label='版本' value={data.version || '—'} hint={data.started_at ? '启动于 ' + fmtTime(data.started_at) + ' UTC' : '这个部署没注入构建信息'} />
      </StatRow> : null}

      {!canSetting ? <GateNote perm='site.setting'>GET /admin/diagnostics 需要 site.setting：本账号没有，面板不渲染。</GateNote> : null}

      {/* 走到这里的 error 已经**不是** debug 关闭那一档（上面提前返回了）：就是我们真没取到，如实报 */}
      {error ? (
        <div role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] leading-relaxed text-foreground'>
          自检结果没能取到（HTTP {error.status}{error.code ? ' ' + error.code : ''}）：{error.message}
        </div>
      ) : null}

      {loading ? <p className='text-[12px] text-muted-foreground'>正在跑自检…</p> : null}

      {data ? (
        <>
          {!data.debug_enabled ? (
            <Panel title='debug 开关关闭'>
              <p className='text-[12px] text-muted-foreground'>debug 关闭时这个端点整体不可用（§21.2 要求 site.setting 且 debug 打开）；界面不应该显示上一次的缓存结果。</p>
            </Panel>
          ) : null}

          <Panel
            title='自检结果'
            note='每项都对应一条会自动红的一致性检查（DB §12 / 后端 §9.8 启动自检）'
            actions={data.readonly ? <Pill tone='outline'>只读：检查项里不含「会拒绝启动」的那几条</Pill> : undefined}
          >
            <DataTable
              columns={[
                { key: 'name', title: '检查项', track: 'minmax(170px,1.4fr)', render: (c: Check) => <span className='text-[13px] font-medium text-foreground'>{c.name}</span> },
                {
                  key: 'result', title: '结果', track: '96px',
                  render: (c: Check) => c.status === 'ok' ? <Pill tone='ok'>通过</Pill>
                    : c.status === 'fail' ? <Pill tone='danger'>异常</Pill>
                    : <Pill tone='warn'>没查</Pill>,
                },
                { key: 'detail', title: '详情', track: 'minmax(260px,2fr)', render: (c: Check) => <span className='truncate text-[12px] text-muted-foreground'>{c.detail || '—'}</span> },
                { key: 'ms', title: '耗时', track: '76px', align: 'end' as const, sortable: true, sortValue: (c: Check) => c.ms, render: (c: Check) => <span className='text-[12px] text-muted-foreground'>{c.ms} ms</span> },
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
              {failed.length === 0 ? <p className='text-[12px] text-muted-foreground'>当前没有异常项。</p> : (
                <div className='flex flex-col gap-1.5'>
                  {failed.map((f) => (
                    <div key={f.name} className='rounded-sm border border-border px-2 py-1'>
                      <div className='flex items-center gap-1.5'><Pill tone='danger'>{f.name}</Pill></div>
                      <p className='text-[11px] text-muted-foreground'>{f.detail}</p>
                      {/* 这里不给每一条编处理办法：后端没给「怎么修」的字段，编出来就是假话。 */}
                      <p className='text-[11px] text-muted-foreground'>处理：看服务日志与 forum check 的输出；修复动作是迁移或运维命令，不在这个页面上。</p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title='运维动作' note='这一屏只有读端点'>
              <p className='text-[12px] leading-relaxed text-muted-foreground'>
                「重建搜索索引」「清理图片缓存」「立即备份」这三颗按钮一个都没有后端端点，
                而 mock 里那个 system.settings 权限点在后端 authz 常量表里也不存在 —— 所以这里不画，
                也不拿一句「请联系管理员」糊过去。
              </p>
              <p className='mt-2 text-[12px] leading-relaxed text-muted-foreground'>
                探针：/healthz（版本）· /readyz（真打数据库与存储），不带 /api 前缀（§21.1）。
                备份本身是 DB §8 的运维流程（pg_dump + 快照）。
              </p>
              <DisabledReason>面板只读：任何「修复」都不在网页上做</DisabledReason>
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

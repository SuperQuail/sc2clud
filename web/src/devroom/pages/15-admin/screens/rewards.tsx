import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { QrCode } from 'lucide-react';
import { Username } from '@/ui/user/username';
import type { BatchItem, Donation, DonationStats, NoticeDefault } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { ConfirmDialog } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 f：打赏核验队列（12.4–12.7 + D3 老设计 + 13.8）。**prop 驱动**：取数在 routes/admin-screens.tsx。
//
// 三条铁律（照 reward/dto.go 与 12.8 的定案）：
//   ① 金额是**整数分**，只有展示时才除 100（§21.1）；
//   ② 只有 approved **且**作者同意公开（records_public）的才进公开统计 —— 最容易算错的一条；
//   ③ 站点不经手资金（12.8）——所以没有「结算 / 入账」这类动作。
//
// 四处与旧版（mock）不同、必须照后端来的事：
//   ① 状态值域是 `pending | approved | rejected | withdrawn`（reward/dto.go 的 QueueInput），
//      没有 mock 里的「hidden_count」；「不计入统计」是 `approved 但不公开`，从 stats 的
//      `all_count - public_count` 得到。
//   ② **核验只接受 `approved | rejected`**（VerifyInput 的 oneof）——`withdrawn` 是**申报人自己的动作**，
//      管理员改不了（POST 会被 400 挡）。所以屏上不做「撤回」按钮。
//   ③ 核验端点只对 **pending** 有意义（再核验一次是又写一次同样的值），这里是界面层的提示，
//      真正的守卫在后端。
//   ④ 收款码：`channel_id` 只是一个 id，**这一屏拿不到那个收款码的图片**（没有按 id 读渠道的端点），
//      所以右栏不画一张假的二维码占位图，只如实显示 id。

const TABS = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type RewardTab = (typeof TABS)[number];
const STATE_LABEL: Record<string, string> = { pending: '待核验', approved: '已通过', rejected: '已拒绝', withdrawn: '已撤回' };
const STATE_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = { pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: 'neutral' };

export type RewardsFilter = { state: RewardTab };

export type RewardsScreenProps = {
  items: Donation[];
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  filter: RewardsFilter;
  onFilterChange: (next: RewardsFilter) => void;
  onLoadMore?: () => void;
  /** 管理侧统计（GET /admin/rewards/stats）：public_* 只算双方都同意公开的 */
  stats: DonationStats | null;
  /** 按渠道的默认提示文案（整表替换；channel 值域 default|wechat|alipay|other） */
  noticeDefaults: NoticeDefault[];
  onSaveNoticeDefaults?: (items: NoticeDefault[]) => void;
  canVerify: boolean;
  canSiteSetting: boolean;
  /** 核验 / 改判：两条出路只有 approved 与 rejected（withdrawn 是申报人自己的动作） */
  onVerify: (ids: string[], state: 'approved' | 'rejected', note: string) => void;
  batchResults?: BatchItem[] | null;
  receipt?: ReactNode;
};

export function RewardsScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  stats, noticeDefaults, onSaveNoticeDefaults, canVerify, canSiteSetting,
  onVerify, batchResults = null, receipt,
}: RewardsScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [draftNotices, setDraftNotices] = useState<NoticeDefault[] | null>(null);
  const [pending, setPending] = useState<{ state: 'approved' | 'rejected'; ids: string[] } | null>(null);

  const active = items.find((r) => r.id === activeId) ?? null;
  const pendingRows = items.filter((r) => r.state === 'pending');
  const failed = (batchResults ?? []).filter((r) => !r.ok);
  const notices = draftNotices ?? noticeDefaults;
  const noticesDirty = draftNotices !== null && JSON.stringify(draftNotices) !== JSON.stringify(noticeDefaults);

  const columns = [
    {
      key: 'pair', title: '打赏人 → 收款人', track: 'minmax(158px,1.5fr)',
      render: (r: Donation) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex min-w-0 items-center gap-1'>
            <Username nickname={r.donor.nickname} handle={r.donor.handle} size='sm' badge='none' />
            <span className='shrink-0 text-muted-foreground'>→</span>
            <Username nickname={r.recipient.nickname} handle={r.recipient.handle} size='sm' badge='none' />
          </span>
          <span className='truncate text-[10px] text-muted-foreground'>
            {r.post_id ? '关联帖子 ' + r.post_id : '未关联帖子'}{r.channel_id ? ' · 收款码 ' + r.channel_id : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'amount', title: '金额', track: 'minmax(80px,0.8fr)', align: 'end' as const, sortable: true, sortValue: (r: Donation) => r.amount_cents,
      render: (r: Donation) => <span className='text-[13px] font-medium text-foreground'>{fmtCents(r.amount_cents)}</span>,
    },
    {
      key: 'txn', title: '交易单号 / 留言', track: 'minmax(116px,1.2fr)',
      render: (r: Donation) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate font-mono text-[11px] text-foreground'>{r.txn_id || '（未填）'}</span>
          <span className='truncate text-[10px] text-muted-foreground'>{r.note || '（无留言）'} · {relTime(r.created_at)}</span>
        </span>
      ),
    },
    { key: 'state', title: '状态', track: '72px', render: (r: Donation) => <Pill tone={STATE_TONE[r.state] ?? 'neutral'}>{STATE_LABEL[r.state] ?? r.state}</Pill> },
    {
      key: 'actions', title: '就地操作', track: 'minmax(184px,1.5fr)',
      render: (r: Donation) => {
        const why = !canVerify ? '本账号没有 reward.verify' : r.state !== 'pending' ? '只有待核验的记录能核验' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary={r.state === 'pending'} disabled={Boolean(why)} onClick={() => setPending({ state: 'approved', ids: [r.id] })}>核验通过</Button>
            <Button disabled={Boolean(why)} onClick={() => setPending({ state: 'rejected', ids: [r.id] })}>拒绝</Button>
            <Button onClick={() => setActiveId(r.id)}>详情</Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='打赏核验队列'
        note='12.4–12.7 / 13.8：作者收款码 + 用户自报 + 管理员人工核验。站点不经手资金，所以没有「结算」这个动作；撤回是申报人自己的事，管理员只能核验（approved / rejected）。'
      />

      <StatRow>
        <Stat label='公开统计金额' value={stats ? fmtCents(stats.public_total_cents) : '—'} tone='info' hint={stats ? 'approved 且双方同意公开 · ' + stats.public_count + ' 笔' : '统计没取到'} />
        <Stat label='全部已通过' value={stats ? fmtCents(stats.all_total_cents) : '—'} hint={stats ? stats.all_count + ' 笔（含不公开的）' : ''} />
        <Stat label='不计入公开统计' value={stats ? stats.all_count - stats.public_count : '—'} hint='approved 但没同意公开' />
        <Stat label='本页待核验' value={pendingRows.length} tone={pendingRows.length ? 'danger' : 'neutral'} hint='队列头上的积压' />
        <Stat label='已选' value={selected.length} />
      </StatRow>

      {!canVerify ? <GateNote perm='reward.verify'>核验通过 / 拒绝按钮不渲染；队列只读。</GateNote> : null}

      <Panel title='统计口径' note='最容易算错的一条：approved ≠ 计入统计'>
        <div className='flex flex-wrap items-center gap-2 text-[12px] text-foreground'>
          <Pill tone='ok'>approved</Pill>
          <span className='text-muted-foreground'>且</span>
          <Pill tone='ok'>双方都同意公开</Pill>
          <span className='text-muted-foreground'>才累加；金额一律整数分，展示时才除 100（§21.1）。</span>
        </div>
      </Panel>

      <Tabs selected={filter.state} onSelect={(id: string) => { onFilterChange({ state: id as RewardTab }); setSelected([]); }}>
        {TABS.map((s) => <Tab key={s} id={s} title={STATE_LABEL[s]!} />)}
      </Tabs>

      <Toolbar>
        <Button disabled={!canVerify || selected.length === 0} onClick={() => setPending({ state: 'approved', ids: selected })}>批量核验通过（{selected.length}）</Button>
        <Button disabled={!canVerify || selected.length === 0} onClick={() => setPending({ state: 'rejected', ids: selected })}>批量拒绝（{selected.length}）</Button>
        {onLoadMore && hasMore ? <Button onClick={onLoadMore} disabled={loading}>加载下一页</Button> : null}
      </Toolbar>

      {failed.length > 0 ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          批量结果：{batchResults!.length - failed.length} 条成功、{failed.length} 条失败（
          {failed.slice(0, 3).map((f) => f.id + '：' + (f.code ?? '失败')).join('；')}）。后端逐条 CAS，成功的已经生效。
        </p>
      ) : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.donor.nickname + ' → ' + r.recipient.nickname}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (r.state !== 'pending' ? '非待核验状态不参与批量操作' : null)}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          loading={loading}
          minWidth={610}
          density='compact'
          empty='这个状态下没有记录'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='申报详情' note='站点只展示收款码，不经手资金（12.8）'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-2 rounded-md border border-dashed border-border p-2'>
                  <span className='flex size-16 items-center justify-center rounded-sm bg-muted'>
                    <QrCode size={30} aria-hidden className='text-muted-foreground' />
                  </span>
                  <span className='flex min-w-0 flex-col leading-tight'>
                    <span className='text-[12px] font-medium text-foreground'>{active.recipient.nickname}</span>
                    <span className='truncate font-mono text-[10px] text-muted-foreground'>收款码 {active.channel_id || '（未填）'}</span>
                    <span className='text-[10px] text-muted-foreground'>
                      这一屏**拿不到那个收款码的图**（没有按 id 读渠道的端点），所以不画一张假的占位图
                    </span>
                  </span>
                </div>
                <KV k='金额（整数分）' v={active.amount_cents + ' 分 = ' + fmtCents(active.amount_cents)} />
                <KV k='交易单号' v={<span className='font-mono text-[11px]'>{active.txn_id || '（未填）'}</span>} />
                <KV k='关联帖子' v={active.post_id || '未关联'} />
                <KV k='申报留言' v={active.note || '（无）'} />
                <KV k='核验人' v={active.verifier ? active.verifier.nickname + ' · ' + relTime(active.verified_at ?? null) : '尚未核验'} />
                <KV k='当前状态' v={<Pill tone={STATE_TONE[active.state] ?? 'neutral'}>{STATE_LABEL[active.state] ?? active.state}</Pill>} />
                <Input
                  label='核验说明（拒绝时必填：双方都能看到）'
                  multiline
                  rows={2}
                  inputClassName='!h-[64px]'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {active.state !== 'pending' ? (
                  <p className='text-[11px] text-muted-foreground'>这一条已经核验过了：再核验就是又写一次同样的值，后端也会按状态挡回来。</p>
                ) : null}
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看详情。</p>
            )}
          </Panel>

          <Panel title='排行榜（top 10）' note='只算同意公开的 approved'>
            {stats && stats.leaderboard.length > 0 ? (
              <ol className='flex flex-col gap-1'>
                {stats.leaderboard.map((row) => (
                  <li key={row.user.handle} className='flex items-center justify-between gap-2 text-[12px]'>
                    <Username nickname={row.user.nickname} handle={row.user.handle} size='sm' badge='none' />
                    <span className='shrink-0 text-foreground'>{fmtCents(row.total_cents)} <span className='text-[10px] text-muted-foreground'>/ {row.count} 笔</span></span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className='text-[12px] text-muted-foreground'>还没有进入公开统计的记录。</p>
            )}
          </Panel>

          <Panel
            title='按渠道的默认提示文案'
            note='整表替换（PATCH /admin/donation-notice-defaults）：传进来的就是替换后的全集'
            actions={
              canSiteSetting ? (
                <>
                  <Button disabled={!noticesDirty} onClick={() => setDraftNotices(null)}>放弃</Button>
                  <Button
                    primary
                    disabled={!noticesDirty}
                    onClick={() => { if (draftNotices && onSaveNoticeDefaults) onSaveNoticeDefaults(draftNotices); setDraftNotices(null); }}
                  >
                    保存
                  </Button>
                </>
              ) : null
            }
          >
            {!canSiteSetting ? (
              <GateNote perm='site.setting'>这四段文案按 site.setting 管，本账号没有：只读。</GateNote>
            ) : null}
            <div className='flex flex-col gap-2'>
              {notices.map((n, i) => (
                <Input
                  key={n.channel}
                  label={CHANNEL_LABEL[n.channel] ?? n.channel}
                  value={n.text}
                  disabled={!canSiteSetting}
                  onChange={(e) => {
                    const next = notices.slice();
                    next[i] = { channel: n.channel, text: e.target.value };
                    setDraftNotices(next);
                  }}
                />
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.state === 'approved' ? '确认核验通过？' : '确认拒绝这笔申报？'}
        danger={pending?.state === 'rejected'}
        confirmText={pending?.state === 'approved' ? '核验通过' : '拒绝并通知'}
        reasonLabel={pending?.state === 'rejected' ? '拒绝理由（必填：双方都能看到）' : '核验说明（可选，进审计）'}
        reasonRequired={pending?.state === 'rejected'}
        body={
          pending?.state === 'approved'
            ? <span>核验 <b>{pending?.ids.length}</b> 笔申报：确认收款人已实际收到款项。通过后写审计 <code>reward.verify</code>；双方同意公开的会进入公开统计。</span>
            : <span>拒绝后状态置 rejected，双方都会收到通知。误判可以改判（approved ↔ rejected，后端允许再核验一次），每次都会留痕。
                <b>撤回是申报人自己的动作</b>（withdrawn），管理员没有这个入口。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) onVerify(pending.ids, pending.state, reason);
          setSelected([]);
          setNote('');
          setPending(null);
        }}
      />
    </div>
  );
}

const CHANNEL_LABEL: Record<string, string> = { default: '默认渠道', wechat: '微信', alipay: '支付宝', other: '其它' };

/** 金额**只在展示时**除 100（§21.1 金额是整数分）。 */
function fmtCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return sign + '¥' + Math.floor(v / 100) + '.' + String(v % 100).padStart(2, '0');
}

/** 相对时间。**不再从 ../mock/core 引**。 */
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.round(hours / 24);
  return days < 31 ? days + ' 天前' : iso.slice(0, 10);
}

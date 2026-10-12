import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { QrCode } from 'lucide-react';
import { Username } from '@/ui/user/username';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { fmtCents, relTime, REWARDS, REWARD_STATE_LABEL, rewardStats, type RewardItem, type RewardState } from '../mock';
import { useIsSuper, useCan } from '../mock/perms';

// 屏 f：打赏核验队列（12.4–12.7 + D3 老设计 + 13.8）。
// 三条铁律：① 金额是**整数分**，只有展示时才除 100；② 只有 approved 且作者同意公开的才进统计；
// ③ 站点不经手资金（12.8）——所以没有「结算/入账」动作，这也正是老站与「订单+回调」路线的分界。

const TABS: RewardState[] = ['pending', 'approved', 'rejected', 'withdrawn'];
const STATE_TONE: Record<RewardState, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: 'neutral',
};

export function RewardsScreen() {
  const canVerify = useCan('reward.verify');
  const isSuper = useIsSuper();
  const [tab, setTab] = useState<RewardState>('pending');
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(REWARDS[0]!.id);
  const [patch, setPatch] = useState<Record<string, RewardState>>({});
  const [pending, setPending] = useState<{ kind: 'approve' | 'reject' | 'withdraw'; ids: string[] } | null>(null);

  const stats = rewardStats();
  const rows = REWARDS
    .map((r) => ({ ...r, state: patch[r.id] ?? r.state }))
    .filter((r) => r.state === tab
      && (channel === 'all' || r.channel.name === channel)
      && (q.trim() === '' || r.txn_id.includes(q.trim()) || r.donor.nickname.includes(q.trim()) || r.recipient.nickname.includes(q.trim())));
  const active = REWARDS.find((r) => r.id === activeId) ?? null;
  const activeState = active ? patch[active.id] ?? active.state : 'pending';

  function apply(ids: string[], next: RewardState) {
    setPatch((p) => {
      const c = { ...p };
      for (const id of ids) c[id] = next;
      return c;
    });
    setSelected([]);
  }

  // 5 列：右栏放收款码与改判说明；「渠道 / 关联帖子 / 收款人」在右栏，
  // 列表只留核验时要盯的四件事：谁给谁、多少钱、单号对不对、什么状态。
  const columns = [
    {
      key: 'pair', title: '打赏人 → 收款人', track: 'minmax(158px,1.5fr)',
      render: (r: RewardItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex min-w-0 items-center gap-1'>
            <Username nickname={r.donor.nickname} size='sm' badge='none' />
            <span className='shrink-0 text-muted-foreground'>→</span>
            <Username nickname={r.recipient.nickname} size='sm' badge='none' />
          </span>
          <span className='truncate text-[10px] text-muted-foreground'>
            {r.channel.name}{r.post_label ? ' · ' + r.post_label : ' · 未关联帖子'}
          </span>
        </span>
      ),
    },
    {
      key: 'amount', title: '金额', track: 'minmax(80px,0.8fr)', align: 'end' as const, sortable: true, sortValue: (r: RewardItem) => r.amount_cents,
      render: (r: RewardItem) => <span className='text-[13px] font-medium text-foreground'>{fmtCents(r.amount_cents)}</span>,
    },
    {
      key: 'txn', title: '交易单号 / 留言', track: 'minmax(116px,1.2fr)',
      render: (r: RewardItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate font-mono text-[11px] text-foreground'>{r.txn_id}</span>
          <span className='truncate text-[10px] text-muted-foreground'>{r.note || '（无留言）'} · {relTime(r.created_at)}</span>
        </span>
      ),
    },
    { key: 'state', title: '状态', track: '72px', render: (r: RewardItem) => <Pill tone={STATE_TONE[r.state]}>{REWARD_STATE_LABEL[r.state]}</Pill> },
    {
      key: 'actions', title: '就地操作', track: 'minmax(184px,1.5fr)',
      render: (r: RewardItem) => {
        const why = !canVerify ? '本账号没有 reward.verify' : r.state !== 'pending' ? '只有待核验的记录能核验；改判要走修改并留痕' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary={r.state === 'pending'} disabled={Boolean(why)} onClick={() => setPending({ kind: 'approve', ids: [r.id] })}>核验通过</Button>
            <DangerAction disabled={Boolean(why)} why={why} onClick={() => setPending({ kind: 'reject', ids: [r.id] })}>拒绝</DangerAction>
            <DropdownMenu
              anchor={<Button>更多</Button>}
              data={[{ key: 'channel', label: '查看收款码' }, { key: 'audit', label: '看这条的审计留痕' }]}
              onSelect={(item) => { if (item?.key === 'channel') setActiveId(r.id); }}
            />
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='打赏核验队列'
        note='12.4–12.7 / D3：作者收款码 + 用户自报 + 管理员人工核验。站点不经手资金，所以没有「结算」这个动作。'
      />

      <StatRow>
        <Stat label='已核验金额（只算公开）' value={fmtCents(stats.approved_total_cents)} tone='info' hint={'approved 且 records_public · ' + stats.approved_count + ' 笔'} />
        <Stat label='待核验' value={stats.pending_count} tone='danger' hint='队列头上的积压' />
        <Stat label='已通过' value={stats.approved_count} />
        <Stat label='已拒绝 / 已撤回' value={stats.rejected_count + ' / ' + stats.withdrawn_count} />
        <Stat label='不计入统计' value={stats.hidden_count} hint='approved 但作者没同意公开' />
      </StatRow>

      {!canVerify ? <GateNote perm='reward.verify'>核验通过 / 拒绝按钮不渲染；队列只读。</GateNote> : null}

      <Panel title='统计口径' note='最容易算错的一条：approved ≠ 计入统计'>
        <div className='flex flex-wrap items-center gap-2 text-[12px] text-foreground'>
          <Pill tone='ok'>approved</Pill>
          <span className='text-muted-foreground'>且</span>
          <Pill tone='ok'>records_public = true</Pill>
          <span className='text-muted-foreground'>才累加；金额一律整数分，展示时才除 100（§21.1）</span>
        </div>
      </Panel>

      <Tabs selected={tab} onSelect={(id: string) => { setTab(id as RewardState); setSelected([]); }}>
        {TABS.map((s) => (
          <Tab key={s} id={s} title={REWARD_STATE_LABEL[s] + ' ' + REWARDS.filter((r) => (patch[r.id] ?? r.state) === s).length} />
        ))}
      </Tabs>

      <Toolbar>
        <Input label='搜索单号 / 昵称' value={q} onChange={(e) => setQ(e.target.value)} placeholder='交易单号或打赏人昵称' />
        <Select
          type={SelectType.INPUT}
          label='收款渠道'
          data={[{ key: 'all', label: '全部渠道' }, { key: '支付宝', label: '支付宝' }, { key: '微信', label: '微信' }]}
          selected={{ key: channel, label: channel === 'all' ? '全部渠道' : channel }}
          onSelect={(item) => { if (item) setChannel(String(item.key)); }}
        />
        <Button disabled={!canVerify || selected.length === 0} onClick={() => setPending({ kind: 'approve', ids: selected })}>批量核验通过（{selected.length}）</Button>
        <DangerAction disabled={!canVerify || selected.length === 0} why={selected.length === 0 ? '先在列表里勾选' : undefined} onClick={() => setPending({ kind: 'reject', ids: selected })}>
          批量拒绝（{selected.length}）
        </DangerAction>
      </Toolbar>

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.donor.nickname + ' → ' + r.recipient.nickname}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (r.state !== 'pending' ? '非待核验状态不参与批量操作' : null)}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          minWidth={610}
          density='compact'
          empty='这个状态下没有记录'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='收款码查看' note='作者挂的收款码（payment_channels）；站点只展示，不经手资金'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-2 rounded-md border border-dashed border-border p-2'>
                  <span className='flex size-16 items-center justify-center rounded-sm bg-muted'>
                    <QrCode size={30} aria-hidden className='text-muted-foreground' />
                  </span>
                  <span className='flex min-w-0 flex-col leading-tight'>
                    <span className='text-[12px] font-medium text-foreground'>{active.recipient.nickname} · {active.channel.name}</span>
                    <span className='truncate font-mono text-[10px] text-muted-foreground'>{active.channel.image_hash.slice(0, 24)}…</span>
                    <span className='text-[10px] text-muted-foreground'>真实实现走 GET /img/{'{hash}'}（老站踩过的坑：收款码 404 —— 12.9）</span>
                  </span>
                </div>
                <KV k='金额（整数分）' v={active.amount_cents + ' 分 = ' + fmtCents(active.amount_cents)} />
                <KV k='交易单号' v={<span className='font-mono text-[11px]'>{active.txn_id}</span>} />
                <KV k='关联帖子' v={active.post_label ?? '未关联'} />
                <KV k='申报留言' v={active.note || '（无）'} />
                <KV k='records_public' v={active.records_public ? '同意公开 → 计入统计' : '不公开 → 不进统计'} />
                <KV k='核验人' v={active.verified_by ? active.verified_by.nickname + ' · ' + relTime(active.verified_at) : '尚未核验'} />
                <KV k='当前状态' v={<Pill tone={STATE_TONE[activeState]}>{REWARD_STATE_LABEL[activeState]}</Pill>} />
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看收款码与详情。</p>
            )}
          </Panel>

          <Panel title='改判与撤回' note='approved ↔ rejected 的改判必须留痕（audit_logs action=reward.verify）'>
            {!isSuper ? (
              <GateNote perm='is_super'>
                「撤回他人的申报」不渲染：撤回是**申报人自己的动作**（12.7，置 withdrawn，不物理删）。
                管理员要改判就走核验（有 audit 留痕），超管才额外有强制撤回。
              </GateNote>
            ) : null}
            <div className='mt-2 flex flex-col gap-1 text-[11px] text-muted-foreground'>
              <span>· 拒绝必须写理由：作者与打赏人都能看到，且写进 audit_logs。</span>
              <span>· 已公开的统计在改判后会立刻重算（只认 approved + records_public）。</span>
              <span>· 没有「余额」「入账」：D3 已定案站点不经手资金。</span>
            </div>
            {active && active.state === 'approved' && active.records_public ? (
              <DisabledReason>这条已经计入公开统计：改判会同时改动作者主页的收入侧数字</DisabledReason>
            ) : null}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.kind === 'approve' ? '确认核验通过？' : pending?.kind === 'reject' ? '确认拒绝这笔申报？' : '确认撤回？'}
        danger={pending?.kind !== 'approve'}
        confirmText={pending?.kind === 'approve' ? '核验通过' : pending?.kind === 'reject' ? '拒绝并通知' : '撤回'}
        reasonLabel={pending?.kind === 'reject' ? '拒绝理由（必填，作者与打赏人都能看到）' : '核验说明（可选，进审计）'}
        reasonRequired={pending?.kind === 'reject'}
        body={
          pending?.kind === 'approve'
            ? <span>核验 <b>{pending.ids.length}</b> 笔申报：确认收款人已实际收到款项。通过后会写审计 <code>reward.verify</code>；若作者同意公开，金额会进入公开统计。</span>
            : pending?.kind === 'reject'
              ? <span>拒绝后状态置 rejected，双方都会收到通知。误判可以改判（approved ↔ rejected），但**每次改判都会留痕**。</span>
              : <span>撤回把申报置 withdrawn（老站语义：不物理删）。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) apply(pending.ids, pending.kind === 'approve' ? 'approved' : pending.kind === 'reject' ? 'rejected' : 'withdrawn');
          setPending(null);
        }}
      />
    </div>
  );
}
import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { Archive, Plus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { TitleBadge } from '@/ui/user/title-badge';
import { DataTable, type Sort } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { TITLES, type AdminTitle } from '../mock';
import { useCan } from '../mock/perms';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';

// 13.6 头衔目录管理。**归档而不是删除**（DB §4.11：archived_at 非空即归档；佩戴中的会被外键自动置空）。
// 权限拆成两个：title.manage（维护目录）与 title.grant（发给用户）——本账号只有后者。
export function TitlesScreen() {
  const canManage = useCan('title.manage');
  const [sort, setSort] = useState<Sort>({ key: 'holders', dir: 'desc' });
  const [archived, setArchived] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [archive, setArchive] = useState<AdminTitle | null>(null);
  const [activeId, setActiveId] = useState<string | null>(TITLES[0]!.id);

  const rows = TITLES.map((t) => ({ ...t, archived_at: archived[t.id] ? '2026-10-12T13:45:00Z' : t.archived_at }));
  const active = rows.find((t) => t.id === activeId) ?? null;

  const columns = [
    {
      key: 'name', title: '头衔', track: 'minmax(160px,1.4fr)', sortable: true, sortValue: (t: AdminTitle) => t.name,
      render: (t: AdminTitle) => (
        <span className='flex min-w-0 items-center gap-2'>
          <TitleBadge title={{ key: t.key, name: t.name, color: t.color }} />
          <span className='truncate font-mono text-[11px] text-muted-foreground'>{t.key}</span>
        </span>
      ),
    },
    { key: 'description', title: '说明', track: 'minmax(200px,1.6fr)', render: (t: AdminTitle) => <span className='truncate text-[12px] text-muted-foreground'>{t.description}</span> },
    { key: 'holders', title: '持有', track: '72px', align: 'end' as const, sortable: true, sortValue: (t: AdminTitle) => t.holders, render: (t: AdminTitle) => <span className='text-[12px] text-foreground'>{t.holders} 人</span> },
    { key: 'state', title: '状态', track: '88px', render: (t: AdminTitle) => (t.archived_at ? <Pill tone='warn'>已归档</Pill> : <Pill tone='ok'>启用中</Pill>) },
    {
      key: 'actions', title: '就地操作', track: 'minmax(190px,1.3fr)',
      render: (t: AdminTitle) => (
        <span className='flex items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          {canManage ? <Button onClick={() => setActiveId(t.id)}>编辑</Button> : null}
          {t.archived_at
            ? <Button disabled={!canManage} onClick={() => setArchived((p) => ({ ...p, [t.id]: false }))}>恢复</Button>
            : (
              <DangerAction disabled={!canManage} why={!canManage ? '本账号没有 title.manage' : undefined} onClick={() => setArchive(t)}>
                <span className='flex items-center gap-1'><Archive size={13} aria-hidden />归档</span>
              </DangerAction>
            )}
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='头衔目录'
        note='13.6：建 / 改 / 归档（不物理删）；佩戴的头衔只有一个，归档或删除时由外键自动置空（DB §4.11）。'
        actions={canManage ? <Button inline={false} height={ControlsHeight.S} icon={icon16(Plus)} onClick={() => setCreateOpen(true)}>新建头衔</Button> : null}
      />

      <StatRow>
        <Stat label='头衔' value={rows.length} />
        <Stat label='启用中' value={rows.filter((t) => !t.archived_at).length} tone='info' />
        <Stat label='已归档' value={rows.filter((t) => t.archived_at).length} />
        <Stat label='持有人次' value={rows.reduce((s, t) => s + t.holders, 0)} hint='一人可持多个头衔' />
      </StatRow>

      {!canManage ? (
        <GateNote perm='title.manage'>
          「新建头衔」「编辑」「归档」不渲染。本账号只有 title.grant（在用户管理屏里把头衔发给某人），
          目录维护属于另一个权限点——和 role.edit / role.assign 是同一种拆分方式。
        </GateNote>
      ) : null}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_268px]'>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          rowLabel={(t) => t.name}
          sort={sort}
          onSortChange={setSort}
          activeKey={activeId}
          onRowClick={(t) => setActiveId(t.id)}
          minWidth={780}
          density='compact'
          empty='还没有头衔'
        />
        <Panel title='头衔详情' note='颜色用 tokens + color-mix 的半透明底，深浅两套都能看'>
          {active ? (
            <>
              <div className='mb-2'>
                <TitleBadge title={{ key: active.key, name: active.name, color: active.color }} size='lg' />
              </div>
              <KV k='key（不可改）' v={active.key} />
              <KV k='name' v={active.name} />
              <KV k='color' v={<span className='font-mono text-[11px]'>{active.color}</span>} />
              <KV k='description' v={active.description} />
              <KV k='archived_at' v={active.archived_at ? active.archived_at.slice(0, 10) : '未归档'} />
              <KV k='holders' v={active.holders + ' 人'} />
              <Input className='mt-2' label='显示名' defaultValue={active.name} disabled={!canManage} />
              <Input label='颜色（hex）' defaultValue={active.color} disabled={!canManage} />
            </>
          ) : (
            <p className='text-[12px] text-muted-foreground'>在左侧点一行查看详情。</p>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        show={archive !== null}
        label='归档这个头衔？'
        danger
        confirmText='归档头衔'
        body={<span>归档 <b>{archive?.name}</b> 后不再出现在可授予列表；已经持有它的人仍然保留（历史），但佩戴会被自动置空。</span>}
        reasonLabel='归档理由（可选，进审计）'
        onClose={() => setArchive(null)}
        onConfirm={() => { if (archive) setArchived((p) => ({ ...p, [archive.id]: true })); setArchive(null); }}
      />

      <Dialog show={createOpen} label='新建头衔' onCloseAttempt={() => setCreateOpen(false)} onOverlayClick={() => setCreateOpen(false)} onEscPress={() => setCreateOpen(false)}>
        <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
          <Input label='key（小写，唯一）' placeholder='speedrunner' />
          <Input label='显示名' placeholder='速通达人' />
          <Input label='颜色' placeholder='#2563eb' />
          <Input label='说明' placeholder='这条头衔是给谁的' />
          <div className='flex justify-end gap-2'>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button primary onClick={() => setCreateOpen(false)}>创建</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
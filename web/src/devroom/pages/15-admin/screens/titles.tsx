import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Archive, Plus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { TitleBadge } from '@/ui/user/title-badge';
import type { Title } from '@/lib/api/admin';
import { DataTable, type Sort } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';

// 13.6 头衔目录管理。**归档而不是删除**（DB §4.11：archived_at 非空即归档；佩戴中的会被外键自动置空）。
// 权限拆成两个：title.manage（维护目录）与 title.grant（发给用户）——发头衔在用户管理屏里。
//
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。
//
// 与旧版（mock）不同的三处、必须照后端来的：
//   ① 后端字段是 **`archived_at`（时间戳，null = 未归档）**，不是 mock 里那个 `archived` 布尔；
//   ② 后端 **没有 `holders`（持有者数）** —— 它需要一条 count 查询，端点没提供。
//      所以屏上不显示「N 人持有」，也不拿 0 冒充（那正是本仓库要消灭的假数据）。
//   ③ 新建走 `POST /admin/titles`（body 里 `archived: false`），改名 / 归档走
//      `PATCH /admin/titles/{id}`（**body 是全字段**：key/name/color/description/archived）。

export type TitlesScreenProps = {
  titles: Title[];
  loading?: boolean;
  error?: ReactNode;
  canManage: boolean;
  onCreate: (b: { key: string; name: string; color: string; description: string }) => void;
  onUpdate: (id: string, b: { key: string; name: string; color: string; description: string; archived: boolean }) => void;
  /** 是否在提交中（禁用按钮，避免重复点） */
  busy?: boolean;
  receipt?: ReactNode;
};

export function TitlesScreen({ titles, loading = false, error = null, canManage, onCreate, onUpdate, busy = false, receipt }: TitlesScreenProps) {
  const [sort, setSort] = useState<Sort>({ key: 'key', dir: 'asc' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archive, setArchive] = useState<Title | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const active = titles.find((t) => t.id === activeId) ?? null;

  const columns = [
    {
      key: 'name', title: '头衔', track: 'minmax(160px,1.4fr)', sortable: true, sortValue: (t: Title) => t.name,
      render: (t: Title) => (
        <span className='flex min-w-0 items-center gap-2'>
          <TitleBadge title={{ key: t.key, name: t.name, color: t.color }} />
          <span className='truncate font-mono text-[11px] text-muted-foreground'>{t.key}</span>
        </span>
      ),
    },
    { key: 'description', title: '说明', track: 'minmax(200px,1.6fr)', render: (t: Title) => <span className='truncate text-[12px] text-muted-foreground'>{t.description}</span> },
    {
      key: 'state', title: '状态', track: '132px',
      render: (t: Title) => (t.archived_at
        ? <span className='flex flex-col leading-tight'><Pill tone='warn'>已归档</Pill><span className='text-[10px] text-muted-foreground'>{t.archived_at.slice(0, 10)}</span></span>
        : <Pill tone='ok'>启用中</Pill>),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(190px,1.3fr)',
      render: (t: Title) => (
        <span className='flex items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          <Button onClick={() => setActiveId(t.id)}>详情</Button>
          {t.archived_at ? (
            <Button
              disabled={!canManage || busy}
              onClick={() => onUpdate(t.id, { key: t.key, name: t.name, color: t.color, description: t.description, archived: false })}
            >
              恢复
            </Button>
          ) : (
            <DangerAction disabled={!canManage || busy} why={!canManage ? '本账号没有 title.manage' : undefined} onClick={() => setArchive(t)}>
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
        note='13.6：建 / 改 / 归档（不物理删）；佩戴的头衔只有一个，归档时由外键自动置空（DB §4.11）。持有者数后端没给，所以这里不显示。'
        actions={canManage ? <Button inline={false} height={ControlsHeight.S} icon={icon16(Plus)} onClick={() => setCreateOpen(true)}>新建头衔</Button> : null}
      />

      <StatRow>
        <Stat label='头衔' value={titles.length} />
        <Stat label='启用中' value={titles.filter((t) => !t.archived_at).length} tone='info' />
        <Stat label='已归档' value={titles.filter((t) => t.archived_at).length} />
        <Stat label='持有者数' value='—' hint='后端没有这个字段（不是 0，是不知道）' />
      </StatRow>

      {!canManage ? (
        <GateNote perm='title.manage'>
          「新建头衔」「归档」「恢复」不渲染。本账号只有 title.grant（在用户管理屏里把头衔发给某人），
          目录维护属于另一个权限点——和 role.edit / role.assign 是同一种拆分方式。
        </GateNote>
      ) : null}

      {receipt}
      {error}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_268px]'>
        <DataTable
          columns={columns}
          rows={titles}
          rowKey={(t) => t.id}
          rowLabel={(t) => t.name}
          sort={sort}
          onSortChange={setSort}
          activeKey={activeId}
          onRowClick={(t) => setActiveId(t.id)}
          loading={loading}
          minWidth={780}
          density='compact'
          empty='还没有头衔'
        />
        <Panel title='头衔详情' note='颜色用 tokens + color-mix 的半透明底，深浅两套都能看'>
          {active ? <EditTitleForm key={active.id} title={active} canManage={canManage} busy={busy} onSave={onUpdate} /> : (
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
        onConfirm={() => {
          if (archive) onUpdate(archive.id, { key: archive.key, name: archive.name, color: archive.color, description: archive.description, archived: true });
          setArchive(null);
        }}
      />

      <CreateTitleDialog
        open={createOpen}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onCreate={(b) => { onCreate(b); setCreateOpen(false); }}
      />
    </div>
  );
}

/** 编辑表单：**全字段提交**（PATCH 的 body 是 TitleInput，没有「只传改动的字段」这回事）。 */
function EditTitleForm({ title, canManage, busy, onSave }: {
  title: Title;
  canManage: boolean;
  busy: boolean;
  onSave: TitlesScreenProps['onUpdate'];
}) {
  const [name, setName] = useState(title.name);
  const [color, setColor] = useState(title.color);
  const [description, setDescription] = useState(title.description);
  const dirty = name !== title.name || color !== title.color || description !== title.description;
  return (
    <>
      <div className='mb-2'>
        <TitleBadge title={{ key: title.key, name, color }} size='lg' />
      </div>
      <KV k='key（不可改）' v={title.key} hint='改 key 等于换一个头衔，后端只按 id 寻址' />
      <KV k='archived_at' v={title.archived_at ? title.archived_at.slice(0, 10) : '未归档'} />
      <Input className='mt-2' label='显示名' value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
      <Input label='颜色（hex）' value={color} disabled={!canManage} onChange={(e) => setColor(e.target.value)} />
      <Input label='说明' value={description} disabled={!canManage} onChange={(e) => setDescription(e.target.value)} />
      <div className='mt-2 flex justify-end gap-2'>
        <Button disabled={!dirty} onClick={() => { setName(title.name); setColor(title.color); setDescription(title.description); }}>放弃</Button>
        <Button
          primary
          disabled={!canManage || !dirty || busy}
          onClick={() => onSave(title.id, { key: title.key, name, color, description, archived: Boolean(title.archived_at) })}
        >
          保存
        </Button>
      </div>
    </>
  );
}

function CreateTitleDialog({ open, busy, onClose, onCreate }: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (b: { key: string; name: string; color: string; description: string }) => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [description, setDescription] = useState('');
  // 就地校验照后端那一份值域（forum/internal/title/service.go 的 validateTitle）：
  // 2026-10-15 实测「新建头衔」稳定 400 —— 后端只说「参数错误」，而 key 带连字符／大写、
  // 颜色不是 #rrggbb 都会中。这里把理由写在输入框下面，按钮也只在合法时才亮。
  // 最常见的两种错法（连字符、大写）**就地纠正**：字段里立刻显示真实要提交的值，不做静默改写。
  // 非拉丁字符（中文 key）不猜、也不硬塞下划线 —— 交给下面那条错误提示说清楚。
  const normalizeKey = (v: string) => v.toLowerCase().replace(/[\s-]+/g, '_');
  const keyError = /^[a-z0-9_]{1,32}$/.test(key.trim()) ? null : '只能是小写字母、数字、下划线，1-32 位（连字符请用 _）';
  const nameError = name.trim() === '' ? '不能为空' : [...name.trim()].length > 32 ? '不能超过 32 字' : null;
  const colorError = color.trim() === '' || /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? null : '必须是 #rrggbb（例如 #2563eb）';
  const descError = [...description].length > 200 ? '不能超过 200 字' : null;
  if (!open) return null;
  const ready = !keyError && !nameError && !colorError && !descError;
  return (
    <Dialog show label='新建头衔' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <Input
          label='key（小写，唯一）'
          value={key}
          onChange={(e) => setKey(normalizeKey(e.target.value))}
          placeholder='speedrunner'
          help='小写字母 / 数字 / 下划线，1-32 位；大写与连字符会自动转成小写与 _'
          error={key.trim() ? (keyError ?? undefined) : undefined}
        />
        <Input
          label='显示名'
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='速通达人'
          error={name.trim() ? (nameError ?? undefined) : undefined}
        />
        <Input
          label='颜色'
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder='#2563eb'
          error={color.trim() ? (colorError ?? undefined) : undefined}
        />
        <Input
          label='说明'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='这条头衔是给谁的'
          error={descError ?? undefined}
        />
        <div className='flex justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            disabled={!ready || busy}
            data-testid='title-create-submit'
            onClick={() => onCreate({ key: key.trim(), name: name.trim(), color: color.trim(), description: description.trim() })}
          >
            创建
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

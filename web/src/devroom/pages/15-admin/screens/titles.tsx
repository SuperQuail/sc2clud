import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Archive, Plus, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { HexColorPicker } from 'react-colorful';
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
  /** 返回 true = 建成了（弹窗据此关闭）；false = 失败，**弹窗必须留着**把输入与原因摆在人眼前 */
  onCreate: (b: { key: string; name: string; color: string; description: string }) => Promise<boolean>;
  /** 新建失败的理由（字段级理由由 errorLine 带出来）；有它就在弹窗里显示，不关窗 */
  createError?: string | null;
  onUpdate: (id: string, b: { key: string; name: string; color: string; description: string; archived: boolean }) => void;
  /** D68：真删一条头衔（参数确认后调，被持有 / 佩戴时后端 409，理由走宿主的 receipt/errorLine） */
  onDelete?: (t: Title) => void;
  /** 删除请求在途（与 archived 保存共用一把「忙」：不允许重复点） */
  deleting?: boolean;
  /** 是否在提交中（禁用按钮，避免重复点） */
  busy?: boolean;
  receipt?: ReactNode;
};

export function TitlesScreen({ titles, loading = false, error = null, canManage, onCreate, createError = null, onUpdate, onDelete, deleting = false, busy = false, receipt }: TitlesScreenProps) {
  const [sort, setSort] = useState<Sort>({ key: 'key', dir: 'asc' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archive, setArchive] = useState<Title | null>(null);
  const [remove, setRemove] = useState<Title | null>(null);
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
          {onDelete ? (
            <DangerAction
              disabled={!canManage || busy || deleting}
              why={!canManage ? '本账号没有 title.manage' : undefined}
              onClick={() => setRemove(t)}
            >
              <span className='flex items-center gap-1' data-testid={'title-delete-' + t.key}><Trash2 size={13} aria-hidden />删除</span>
            </DangerAction>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='头衔目录'
        note='13.6：建 / 改 / 归档 / 删除（D68：删除只在无人引用时放行，而且管理屏看得到归档项）。持有者数后端没给，所以这里不显示。'
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

      {onDelete ? (
        <ConfirmDialog
          show={remove !== null}
          label='删除这条头衔？'
          danger
          confirmText='确认删除'
          // D68：删除是**补归档的逃生门**（key 唯一列被旧词占用时唯一出路）。后端在持有名单 /
          // 正佩戴没清之前回 409 并把数字写进 fields —— 理由由宿主的 errorLine 摆进 receipt，屏不装懂。
          // 无引用的头衔直接物化删除；user_titles 的历史行不会被级联清空。
          body={
            <span>
              从头衔目录里物理删除 <b>{remove?.name}</b>（key 的唯一性一并释放）。
              只要还有人持有或佩戴着它，后端会拒绝并把人数字在错误里 —— 那时先去用户管理收回。
            </span>
          }
          onClose={() => setRemove(null)}
          onConfirm={() => {
            if (remove) onDelete(remove);
            setRemove(null);
          }}
        />
      ) : null}

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
        error={createError}
        onClose={() => setCreateOpen(false)}
        // **失败不关窗**（2026-10-15 实测）：原来无论成败都立刻关，失败时人只看到「弹窗关了」= 以为建好了，
        // 列表里没有那一行 —— 就成了「创建后消失」的观感。现在只有真的建成才关。
        onCreate={async (b) => {
          if (await onCreate(b)) setCreateOpen(false);
        }}
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
      <ColorFieldRow color={color} disabled={!canManage} onChange={setColor} />
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

/** 颜色行：react-colorful 的取色器 + 当前值（十六进制）。**不自造取色控件**（用户 2026-10-15 明确）。
 *  库输出就是 `#rrggbb` 小写，正好是后端与 DB CHECK 的形状，不需要再校验。 */
function ColorFieldRow({ color, disabled, onChange }: { color: string; disabled?: boolean; onChange: (hex: string) => void }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[12px] font-medium text-foreground'>颜色</span>
      <div className='flex items-start gap-3' aria-disabled={disabled}>
        <div className={disabled ? 'pointer-events-none opacity-50' : undefined}>
          <HexColorPicker color={color} onChange={onChange} style={{ width: 168, height: 120 }} />
        </div>
        <span className='mt-1 font-mono text-[12px] text-muted-foreground'>{color}</span>
      </div>
    </div>
  );
}

function CreateTitleDialog({ open, busy, error, onClose, onCreate }: {
  open: boolean;
  busy: boolean;
  /** 上一次提交失败的理由（含后端字段级理由）：显示在弹窗里，输入不丢 */
  error?: string | null;
  onClose: () => void;
  /** 返回值 = 是否建成（调用方据此决定关不关窗） */
  onCreate: (b: { key: string; name: string; color: string; description: string }) => Promise<void>;
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
  // 颜色不再校验：取色器（react-colorful）输出的就是合法 #rrggbb
  const descError = [...description].length > 200 ? '不能超过 200 字' : null;
  if (!open) return null;
  const ready = !keyError && !nameError && !descError;
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
        <ColorFieldRow color={color} onChange={setColor} />
        <Input
          label='说明'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='这条头衔是给谁的'
          error={descError ?? undefined}
        />
        {error ? (
          <p role='alert' data-testid='title-create-error' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
            {error}
          </p>
        ) : null}
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

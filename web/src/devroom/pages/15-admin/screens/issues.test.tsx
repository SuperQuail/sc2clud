import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IssuesAdminScreen, type IssuesAdminFilter } from './issues';
import type { IssueAdmin } from '@/lib/api/admin';

// 「Issue 管理」屏的屏内行为：
//   ① 「归档」走二次确认收集 reason，再把 (id, reason) 交给宿主；
//   ② 「恢复」只出现在已归档行（未归档行不许亮一个点了必失败的按钮）；
//   ③ 归档档位（未归档/已归档/全部）改了就报给宿主 —— 取数在宿主，屏不自己筛。

function row(over: Partial<IssueAdmin> = {}): IssueAdmin {
  return {
    id: 'i-1',
    number: 42,
    kind: 'bug',
    title: '触发器里 Wait 之后变量被清空',
    body_html: '<p>正文</p>',
    status: 'keep_open',
    tags: ['触发器'],
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-15T10:00:00Z',
    archived_at: null,
    archived_by: null,
    archive_reason: '',
    author: { handle: 'alice', nickname: '爱丽丝', avatar_hash: 'a1b2c3' },
    topic: { id: 't-1', title: '教程合集' },
    ...over,
  };
}

const ARCHIVED = row({ id: 'i-2', number: 41, title: '被归档的那条', archived_at: '2026-10-16T02:00:00Z', archived_by: { handle: 'mod', nickname: '审核员' }, archive_reason: '重复反馈' });

function Harness({ items, onArchive, onRestore }: {
  items: IssueAdmin[];
  onArchive?: (id: string, reason: string) => void;
  onRestore?: (id: string) => void;
}) {
  const [seen, setSeen] = useState<IssuesAdminFilter[]>([]);
  return (
    <>
      <IssuesAdminScreen
        items={items}
        hasMore={false}
        filter={{ archived: '0', status: 'all', kind: 'all', q: '' }}
        onFilterChange={(f) => setSeen((prev) => [...prev, f])}
        canManage
        onArchive={onArchive ?? (() => {})}
        onRestore={onRestore ?? (() => {})}
      />
      {/* 宿主的观测点：屏只回传「宿主该用哪个档位」，它自己不筛 */}
      <p data-testid='seen-archived'>{seen.map((f) => f.archived).join(',')}</p>
    </>
  );
}

it('归档走二次确认：弹层收 reason，确认后把 (id, reason) 交给宿主', () => {
  const seen: [string, string][] = [];
  render(<Harness items={[row()]} onArchive={(id, reason) => seen.push([id, reason])} />);

  // 精确匹配：Tab 上的「已归档」也含「归档」二字
  fireEvent.click(screen.getByRole('button', { name: '归档' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('触发器里 Wait');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '重复反馈' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));

  expect(seen).toEqual([['i-1', '重复反馈']]);
});

it('「恢复」只出现在已归档行；未归档行没有它', () => {
  render(<Harness items={[row(), ARCHIVED]} onRestore={vi.fn()} />);
  const archivedRow = screen.getByTestId('issue-admin-row-i-2');
  expect(within(archivedRow).getByTestId('issue-restore-i-2')).toBeTruthy();
  expect(screen.queryByTestId('issue-restore-i-1')).toBeNull();
  // 归档时间与原因列在已归档行上是**看得见的信息**（不是只在详情里）
  expect(archivedRow.textContent).toContain('重复反馈');
});

it('恢复不发确认弹层，直接交给宿主（恢复是低风险动作）', () => {
  const seen: string[] = [];
  render(<Harness items={[ARCHIVED]} onRestore={(id) => seen.push(id)} />);
  fireEvent.click(screen.getByTestId('issue-restore-i-2'));
  expect(seen).toEqual(['i-2']);
});

it('归档档位是由服务端筛的：点「已归档」把 archived=1 报给宿主', () => {
  render(<Harness items={[row()]} />);
  fireEvent.click(screen.getByRole('button', { name: /已归档/ }));
  // 屏自己不过滤 —— 归档档位进 query，由容器发给后端
  expect(screen.getByTestId('seen-archived').textContent).toBe('1');
});

it('表格列：#编号 / 所属主题都看得见（列表不藏在详情里）', () => {
  render(<Harness items={[row()]} />);
  const one = screen.getByTestId('issue-admin-row-i-1');
  expect(one.textContent).toContain('#42');
  expect(one.textContent).toContain('教程合集');
  expect(one.textContent).toContain('爱丽丝');
});

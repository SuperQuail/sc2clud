import { useState } from 'react';
import { ADMIN_ACLS, ADMIN_BOARDS, ADMIN_GROUP_ACLS, DEMO_GROUPS, DIAGNOSTICS_ROOM } from './room-data';
import { DEMO_ROLES, DEMO_USERS } from './mock/fixtures';
import { BoardsScreen, type BoardPatch } from './screens/boards';
import { DiagnosticsScreen } from './screens/diagnostics';

// 两个房间（舞台）从 15-admin/index.tsx 搬出来（那个文件在 gate:size 的 500 行线上）。
// **只搬位置**：行为与数据一个字没改 —— 房间仍然不发任何请求。

/** 分区管理屏的房间版（数据在 ./room-data）。 */
export function BoardsRoom() {
  const [boards, setBoards] = useState(ADMIN_BOARDS);
  const [boardId, setBoardId] = useState<string | null>(ADMIN_BOARDS[0]?.id ?? null);
  const [savedAt, setSavedAt] = useState(0);
  const [receipt, setReceipt] = useState<string | null>(null);
  const say = (msg: string) => setReceipt('（房间演示：这里不发请求）' + msg);
  const board = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const id = board?.id ?? '';
  return (
    <BoardsScreen
      key={id}
      boards={boards}
      boardId={board?.id ?? null}
      onSelect={(next) => { setBoardId(next); setReceipt(null); }}
      savedAt={savedAt}
      onSave={(patch: Partial<BoardPatch>) => {
        setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } as typeof b : b)));
        setSavedAt((n) => n + 1);
        say('已保存 ' + Object.keys(patch).join('、'));
      }}
      onMove={(next) => { setBoards((prev) => next.map((x) => prev.find((b) => b.id === x)!)); say('顺序已保存（' + next.length + ' 个分区，全量顺序）'); }}
      roles={DEMO_ROLES}
      acl={ADMIN_ACLS[id] ?? []}
      onAclSave={(acls) => say('名单已保存（全量替换：' + acls.length + ' 行）')}
      groups={DEMO_GROUPS}
      groupAcl={ADMIN_GROUP_ACLS[id] ?? []}
      onGroupAclSave={(acls) => say('按组名单已保存（全量替换：' + acls.length + ' 行）')}
      moderators={board ? board.moderators.map((m, i) => ({ ...m, grown_at: i === board.moderators.length - 1 && board.moderators.length > 1 ? '2026-08-01T00:00:00Z' : null })) : []}
      candidates={DEMO_USERS.slice(0, 6).map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))}
      onGrantModerator={(userId) => say('任命 ' + userId + ' 为版主')}
      onRevokeModerator={(userId) => say('免掉 ' + userId)}
      onCreate={(b) => { say('新建分区 /' + b.slug + '（slug 建后不可改）'); setBoards((prev) => [...prev, { ...ADMIN_BOARDS[0]!, id: 'b-new', slug: b.slug, name: b.name, description: b.description, topic_count: 0, post_count: 0, today_count: 0, moderators: [] }]); }}
      onSetStatus={(status, reason) => { setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b))); say('状态改成 ' + status + (reason ? '（说明：' + reason + '）' : '')); }}
      canManage
      receipt={receipt ? <p className='text-[12px] text-muted-foreground'>{receipt}</p> : null}
    />
  );
}

/** 自检面板的房间版（只读屏，给一份本地结果）。 */
export function DiagnosticsRoom() {
  return <DiagnosticsScreen data={DIAGNOSTICS_ROOM} canSetting />;
}

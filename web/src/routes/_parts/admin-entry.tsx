import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { appPath } from '@/lib/url';
import { useSession } from '@/lib/perms';

// 顶栏那颗「管理后台」。**为什么单独一个文件**：routes/admin.tsx 静态引用 12 个后台屏（带 mock 数据），
// 而壳（app/shell.tsx）是首屏的一部分 —— 从 admin.tsx 引这颗按钮，等于把整个后台拖进首屏 chunk。
// 这是真实踩到的一次：拆出来之前首屏 JS 涨到 140KB+/150KB（后台的 mock 全在里面）。
//
// 权限点两套命名（§21.2 的 post.* 与 RBAC权限树设计.md §3 的 topic.*）不一致，见 routes/admin.tsx 的说明；
// 这里按「任一套命中即显示」，`/me` 还没给出 perms 时**不显示**（顶栏多一颗进不去的按钮比不显示更糟）。
const ADMIN_PERMS = [
  'user.ban', 'user.role.change', 'role.edit', 'role.assign', 'board.manage', 'post.review', 'topic.move',
  'report.handle', 'reward.verify', 'donation.review', 'title.grant', 'title.manage', 'mail.manage',
  'site.setting', 'system.settings', 'audit.view', 'audit.read',
];

// perms 缺席时**不显示**：/me 的形状变了不该让整壳崩（这个容错是被一条测试逼出来的 ——
// mock 少给一个字段时，整棵壳在 AdminEntryButton 上抛错、整页变错误边界）。
export function hasAdminEntry(session: { perms?: string[]; is_super?: boolean } | null): boolean {
  if (!session) return false;
  if (session.is_super) return true;
  return (session.perms ?? []).some((p) => ADMIN_PERMS.includes(p));
}

export function AdminEntryButton() {
  const session = useSession();
  if (!session.isLoggedIn || !hasAdminEntry(session.session)) return null;
  return (
    <Button inline={false} height={ControlsHeight.S} href={appPath('admin/users')}>
      管理后台
    </Button>
  );
}

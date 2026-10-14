import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { fetchDiagnostics } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { DiagnosticsScreen } from '@/devroom/pages/15-admin/screens/diagnostics';

// ── 屏 l：自检面板（C3 已落地）────────────────────────────────────────────
// 双门控：**site.setting 且 debug 开关打开**。debug 关掉时端点整体回 **404 common.not_found**
// （不是空 200 —— 空 200 会让「生产上关掉了」与「跑了但没结果」在界面上长得一模一样）。
// 所以这一屏拿不到数据时要把那个 404 如实说出来，并说明它是「关掉了」而不是「系统有问题」。

export function DiagnosticsScreenContainer() {
  const session = useSession();
  const q = useQuery({ queryKey: qk.adminDiagnostics(), queryFn: ({ signal }) => fetchDiagnostics(signal) });
  const status = isApiError(q.error) ? q.error.status : 0;

  return (
    <DiagnosticsScreen
      data={q.data ?? null}
      loading={q.isPending}
      error={q.error ? {
        message: errorLine(q.error) ?? '',
        status,
        // 404 在这里是**预期内的两件事之一**：debug 关闭（后端刻意的错误码），或者这条路由真的不在
        disabled: status === 404,
      } : null}
      canSetting={can(session.session, 'site.setting')}
    />
  );
}

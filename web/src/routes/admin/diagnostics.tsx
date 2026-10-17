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
        // **错误码**才是判据（View 里 isDebugOff 读它）：debug 关闭回的是 common.not_found，
        // 而「这条路由真的不在」是 common.route_not_found —— 状态码都是 404，屏上却是两种话。
        code: isApiError(q.error) ? q.error.code : '',
      } : null}
      canSetting={can(session.session, 'site.setting')}
    />
  );
}

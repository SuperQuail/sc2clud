import { useQuery } from '@tanstack/react-query';
import { qk } from './query/keys';
import { fetchMe } from './api/auth';

// 权限：**只决定「显不显示」**，不是安全边界（前端方案 §5.4 / 后端方案 §9.8）。
// 真源是 GET /api/v1/me 的 perms[] 与 is_super；后端 authz.Can 是唯一拦截点。
// 禁止写「因为按钮没显示所以后端不用查权限」这种注释。

export function useSession() {
  const q = useQuery({
    queryKey: qk.me(),
    queryFn: ({ signal }) => fetchMe(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return { session: q.data ?? null, isLoggedIn: q.data != null, isLoading: q.isPending, error: q.error };
}

export function can(session: { perms?: string[]; is_super?: boolean } | null, perm: string): boolean {
  if (!session) return false;
  if (session.is_super) return true;
  // perms 缺席时按「没有」处理，不按「全有」：这一层只决定显不显示，判错方向也要偏保守
  return (session.perms ?? []).includes(perm);
}

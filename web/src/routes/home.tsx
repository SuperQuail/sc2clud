import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { fetchHealth } from '@/lib/api/system';
import { isApiError } from '@/lib/api/errors';

// F0 的验收页面：真实调通后端探针，证明「路由 → Query → api client → 后端」整条链是通的
export function HomePage() {
  const health = useQuery({
    queryKey: qk.health(),
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 60_000,
  });

  return (
    <section className='flex flex-col gap-4'>
      <h1 className='text-xl font-semibold text-foreground'>SC2clud</h1>
      <p className='text-sm text-muted-foreground'>重写版前端骨架（F0）。</p>
      <dl className='w-fit rounded border border-border bg-muted px-4 py-3 text-sm'>
        <dt className='text-muted-foreground'>后端探针</dt>
        <dd className='text-foreground'>
          {health.isPending ? '检查中…' : null}
          {health.isError
            ? '不可用：' + (isApiError(health.error) ? health.error.message : '未知错误')
            : null}
          {health.data ? health.data.status + ' · v' + health.data.version : null}
        </dd>
      </dl>
    </section>
  );
}

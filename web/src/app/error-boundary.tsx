import { useRouteError } from 'react-router';
import { apiErrorLine, isApiError } from '@/lib/api/errors';

// 路由级错误边界：不吞错、不静默降级（前端方案 §1.3 / 复盘根因 5）
export function RouteError() {
  const error = useRouteError();
  const detail = isApiError(error) ? apiErrorLine(error) : '页面出错了';
  return (
    <section className='py-16 text-center'>
      <h1 className='text-lg font-semibold text-foreground'>出错了</h1>
      <p className='mt-2 text-sm text-muted-foreground'>{detail}</p>
    </section>
  );
}

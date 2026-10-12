import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';

// 默认值只在这里写死，组件里不许各写各的（前端方案 §5.3）
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => {
          // 4xx 重试没有意义；5xx 与网络错误重试 2 次
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return count < 2;
        },
      },
    },
  });
}

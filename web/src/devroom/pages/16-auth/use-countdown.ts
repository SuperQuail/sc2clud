import { useEffect, useState } from 'react';

// 倒计时：冷却（重发验证邮件 1 分钟 1 次）与限流（429 的 Retry-After）都用它。
// 用 setTimeout 每秒重挂一次而不是 setInterval：依赖只有 left 一个，
// 既不会漏清定时器，也不会让 eslint 的 exhaustive-deps 报警。
export function useCountdown(initial: number) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return { left, restart: setLeft };
}

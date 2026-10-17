import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { noticeStreamUrl } from '@/lib/api/social';
import { qk } from '@/lib/query/keys';

// 通知的**实时性**（拍板 L11：老站已经有实现，参考其代码复现）。
//
// 老站的客户端（site/crates/sc2clud-web/templates/inbox.html:242-276）是两件事叠在一起：
//   · `new EventSource(base + '/stream')` 为主 —— 毫秒级；
//   · `setInterval(pull, 30000)` 兜底 —— 断线重连/漏事件时补上。
// 这里逐条照做，只换「收到之后干什么」：老站就地追加气泡，这里**重取一次**
// （通知列表的分档/payload/actor 那套渲染逻辑已经在 GET /notifications 里了，再写一份必然漂移）。
//
// 服务端那边只推一个「变了」的信号，不推正文（见 forum/internal/notify/stream.go 文件头）。
//
// 为什么兜底轮询是 30 秒而不是更短：/unread-count 是索引上的 COUNT，但它仍然是一次网络往返；
// 老站用 30 秒是权衡过的（省带宽），本站在同一条取舍上。
const FALLBACK_MS = 30_000;

export type LiveStatus = 'live' | 'polling';

/** 返回当前是「SSE 连着」还是「只在轮询」—— 界面上要能看出来（否则实时性坏了没人知道）。 */
export function useLiveNotices(enabled: boolean): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('polling');

  useEffect(() => {
    if (!enabled) {
      setStatus('polling');
      return;
    }
    /** 信号与轮询兜底共用同一条重取路径：角标 + 当前已加载的通知列表 */
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: qk.unread() });
      void qc.invalidateQueries({ queryKey: qk.notifications() });
    };
    const timer = window.setInterval(refresh, FALLBACK_MS);
    // 老站也判了 `window.EventSource`：没有它（老浏览器/测试环境）只剩轮询，不假装实时
    if (typeof EventSource === 'undefined') {
      setStatus('polling');
      return () => window.clearInterval(timer);
    }
    const es = new EventSource(noticeStreamUrl());
    es.onopen = () => setStatus('live');
    es.addEventListener('unread', refresh);
    // 断线**不关掉**：浏览器自己会按 retry 重连（老站同一条注释：「断线由浏览器自动重连」）。
    // 这里只把状态退回「轮询」，让界面说实话。
    es.onerror = () => setStatus('polling');
    return () => {
      window.clearInterval(timer);
      es.close();
    };
  }, [enabled, qc]);

  return status;
}

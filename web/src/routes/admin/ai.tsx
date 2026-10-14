import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchAiConfig,
  patchAiConfig,
  saveAiSecret,
  testAiConfig,
} from '@/lib/api/admin';
import type {
AiConfig,
AiTestView,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { AiReviewScreen } from '@/devroom/pages/15-admin/screens/ai-review';
import type { AiTestFailure } from '@/devroom/pages/15-admin/screens/ai-bits';

// ── 屏 k：AI 审核（交接单 H2）────────────────────────────────────────────
// 依赖 GET/PATCH /admin/ai/config、POST /admin/ai/config/secret、POST /admin/ai/test（四条都已在）。
// **PATCH 只写传进来的字段**（ConfigPatch 全是指针，nil = 不动）→ 屏上把「改动过的键」收集成 draft 再发。
// 密钥只写不回显：保存成功后 invalidate 一次配置，界面从 has_secret 重新读，**不使用本地假设**。

/**
 * 连通测试失败的**四档**（D12）。每一档对应一个不同的动作，所以必须分得开：
 *   · no_key  —— 还没存 key：去「API Key」那一栏粘贴保存（**这一档不发请求**，见下面 onTest 的注释）；
 *   · auth    —— key 被拒（401/403）：key 错了或被上游吊销；
 *   · timeout —— 超时（408 / 网络层）：地址不通或太慢，按「拿不准」转人工；
 *   · server  —— 服务端内部错误（5xx）：看服务日志与请求编号。
 * 状态码为 0 = 网络层就没出去（client.ts 对 fetch 失败的统一值）。
 */
export function classifyTestFailure(e: unknown): AiTestFailure {
  const status = isApiError(e) ? e.status : 0;
  const detail = errorLine(e) ?? '';
  const message = detail + (status ? '（HTTP ' + status + '）' : '');
  if (status === 401 || status === 403) {
    return { kind: 'auth', label: '密钥 / 鉴权', message: '上游拒绝了这次调用：' + message + '。去「API Key」那一栏换一把再试。' };
  }
  if (status === 408 || status === 0 || /timeout|超时|deadline/i.test(detail)) {
    return { kind: 'timeout', label: '网络 / 超时', message: '这次外呼没在超时上限内回来：' + message + '。地址不通或上游太慢；超时按「拿不准」转人工，**不是放行**。' };
  }
  if (status >= 500) {
    return { kind: 'server', label: '服务端内部错误', message: '后端在执行这次外呼时挂了：' + message + '。看服务日志与这个请求编号，不是配置的问题。' };
  }
  return { kind: 'server', label: '测试失败', message: '这次连通测试没成功：' + message };
}

export function AiReviewScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiTestView | null>(null);
  const [testFailure, setTestFailure] = useState<AiTestFailure | null>(null);

  const cfg = useQuery({ queryKey: qk.adminAiConfig(), queryFn: ({ signal }) => fetchAiConfig(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminAiConfig() });
  const patch = useMutation({
    mutationFn: (body: Partial<AiConfig>) => patchAiConfig(body),
    onSuccess: (next, body) => { setReceipt('已保存 ' + Object.keys(body).join('、')); void qc.setQueryData(qk.adminAiConfig(), next); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const secret = useMutation({
    mutationFn: saveAiSecret,
    onSuccess: () => { setReceipt('密钥已保存（只写不回显，界面上永远看不到它）'); refresh(); },
    onError: (e) => setReceipt('保存密钥失败：' + (errorLine(e) ?? '')),
  });
  const test = useMutation({
    mutationFn: testAiConfig,
    onSuccess: (r) => { setTestResult(r); setTestFailure(null); setReceipt(null); refresh(); },
    // **失败就地显示**（D12）：不 rethrow、不落进路由的错误边界（那会整页变成「出错了」）。
    // 原来这一档写的是 setReceipt('连通测试失败：…')：回执区在屏幕最上方，而按钮在下面的「连通测试」面板里 ——
    // 点了之后视线范围内什么都没有，看着就是「点了没反应」。
    onError: (e) => { setTestResult(null); setTestFailure(classifyTestFailure(e)); },
  });

  return (
    <AiReviewScreen
      config={cfg.data ?? null}
      loading={cfg.isPending}
      error={cfg.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          AI 配置没能加载（HTTP {isApiError(cfg.error) ? cfg.error.status : 0}）：{errorLine(cfg.error)}
        </p>
      ) : null}
      canSetting={can(session.session, 'site.setting')}
      onPatch={(body) => patch.mutate(body)}
      onSaveSecret={(key) => secret.mutate(key)}
      onTest={() => {
        // **没配 key 时不发那一次请求**：后端这时回的是 500 common.internal（LoadKey 的裸 error 被兜成 500），
        // 错误码里没有「缺 key」这个信息 —— 只有配置里的 has_secret 知道。与其让管理员去猜「服务端内部错误」，
        // 不如就地告诉他去配 key（顺带也真的省掉一次必然失败的外呼）。
        if (cfg.data && !cfg.data.has_secret) {
          setTestResult(null);
          setTestFailure({
            kind: 'no_key',
            label: '还没配密钥',
            message: '这个站点还没保存 API Key，AI 不会外呼（零外呼是刻意的：新帖一律留 pending 进人工队列）。先在「API Key」那一栏粘贴保存，再点这里。',
          });
          return;
        }
        setTestFailure(null);
        test.mutate();
      }}
      testResult={testResult}
      testFailure={testFailure}
      busy={patch.isPending || secret.isPending || test.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

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

// ── 屏 k：AI 审核（交接单 H2）────────────────────────────────────────────
// 依赖 GET/PATCH /admin/ai/config、POST /admin/ai/config/secret、POST /admin/ai/test（四条都已在）。
// **PATCH 只写传进来的字段**（ConfigPatch 全是指针，nil = 不动）→ 屏上把「改动过的键」收集成 draft 再发。
// 密钥只写不回显：保存成功后 invalidate 一次配置，界面从 has_secret 重新读，**不使用本地假设**。

export function AiReviewScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiTestView | null>(null);

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
    onSuccess: (r) => { setTestResult(r); setReceipt(null); refresh(); },
    onError: (e) => { setTestResult(null); setReceipt('连通测试失败：' + (errorLine(e) ?? '')); },
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
      onTest={() => test.mutate()}
      testResult={testResult}
      busy={patch.isPending || secret.isPending || test.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

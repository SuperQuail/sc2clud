import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Clock, KeyRound, PlugZap } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { AiConfig, AiTestView } from '@/lib/api/admin';
import { TestResult } from './ai-bits';
import { ConfirmDialog } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// D7 AI 审核编辑器（管理端）。唯一真源：完全重构/后端设计/d7-ai-review.md；
// 契约真源：forum/internal/aireview/dto.go，路由见 aireview/handler.go。
//
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。四个端点都已在：
//   GET /admin/ai/config · PATCH /admin/ai/config · POST /admin/ai/config/secret · POST /admin/ai/test
//
// 三条设计纪律在这里要看得见：
//   ① **密钥只写不回显**：GET 只给 `has_secret` 与 `secret_updated_at`（d7 §8 验收 12）；
//   ② **AI 失败不挡发帖**：`last_error` 摆在配置旁边，而不是藏进日志；
//   ③ AI 不删内容：界面上没有任何「删除」动作，最多 hidden（可恢复）。
// 权限沿用 **site.setting** —— 不新造权限点（d7 §8）。
//
// 与旧版（mock）不同的三处：
//   ① 字段名与值域照 `ConfigView`：`thinking` / `strict_mode` 是布尔、`timeout_ms` 与
//      `max_output_tokens` 是数字、**`prompt` 与 `prompt_report` 是两栏**（新建帖 / 举报复核）；
//      mock 里的 `provider` 值域（`deepseek|openai`）与阈值面板都不是契约。
//   ② **没有 `GET /admin/ai/stats`**：mock 的「用量与失败率」两栏后端没有端点，**不画**。
//   ③ **`POST /admin/ai/test` 的入参是一个空 body**（aireview/handler.go 的 test：不绑定任何入参），
//      它发的是配置里那段提示词 + 固定短文本，**不接受「拿这篇内容试跑」**。
//      所以这里只有一颗「测试连通」，没有那个任意内容的试跑表单 ——
//      要做得先给 test 加 `{title, content, trigger}` 三个入参（请求后端改契约，不是前端自己造）。

const PROVIDERS = [
  { key: 'deepseek', label: 'deepseek' },
  { key: 'openai', label: 'openai（协议相同）' },
];

export type AiReviewScreenProps = {
  config: AiConfig | null;
  loading?: boolean;
  error?: ReactNode;
  canSetting: boolean;
  /** 只发改动过的字段（ConfigPatch 全是指针，nil = 不动） */
  onPatch: (patch: Partial<AiConfig>) => void;
  /** 只写不回显 */
  onSaveSecret: (apiKey: string) => void;
  /** 连通测试：**没有入参**，发的是配置里的提示词 + 一段固定短文本 */
  onTest: () => void;
  /** 最近一次连通测试的回执 */
  testResult?: AiTestView | null;
  busy?: boolean;
  receipt?: ReactNode;
};

export function AiReviewScreen({
  config, loading = false, error = null, canSetting,
  onPatch, onSaveSecret, onTest, testResult = null, busy = false, receipt,
}: AiReviewScreenProps) {
  const [draft, setDraft] = useState<Partial<AiConfig>>({});
  const [secret, setSecret] = useState('');
  const [confirmSecret, setConfirmSecret] = useState(false);

  if (!config) {
    return (
      <div className='flex flex-col gap-3'>
        <ScreenHead title='AI 审核' note='d7：AI 是第一道审核，人是最后一道。' />
        {error}
        {loading ? <Panel title='配置'><p className='text-[12px] text-muted-foreground'>正在加载 /admin/ai/config…</p></Panel> : null}
        {!loading && !error ? <Panel title='配置'><p className='text-[12px] text-muted-foreground'>没有拿到配置。</p></Panel> : null}
      </div>
    );
  }

  const cfg = { ...config, ...draft };
  const dirtyKeys = Object.keys(draft).filter((k) => JSON.stringify((draft as Record<string, unknown>)[k]) !== JSON.stringify((config as unknown as Record<string, unknown>)[k]));
  const dirty = dirtyKeys.length > 0;
  const stopped = Boolean(cfg.last_error);

  function patch(next: Partial<AiConfig>) {
    setDraft((d) => {
      const merged = { ...d, ...next };
      // 改回原值就把这一项从「待保存」里去掉：否则按钮会一直亮着而请求里什么都没变
      for (const k of Object.keys(merged) as (keyof AiConfig)[]) {
        if (JSON.stringify(merged[k]) === JSON.stringify(config![k])) delete merged[k];
      }
      return merged;
    });
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='AI 审核编辑器'
        note='d7：新帖先判一次；被举报到阈值用「举报复核」那套提示词再审一次；复审仍不过或拿不准 → 人工。权限沿用 site.setting。'
        actions={
          <>
            <Pill tone={dirty ? 'warn' : 'ok'}>{dirty ? '未保存：' + dirtyKeys.length + ' 项' : '已保存'}</Pill>
            <Button disabled={!canSetting || !dirty || busy} onClick={() => setDraft({})}>放弃改动</Button>
            <Button primary disabled={!canSetting || !dirty || busy} onClick={() => { onPatch(draft); setDraft({}); }}>
              保存改动
            </Button>
          </>
        }
      />

      <StatRow>
        <Stat label='开关' value={cfg.enabled ? '已启用' : '已关闭'} tone={cfg.enabled ? 'info' : 'neutral'} hint={cfg.enabled ? '' : '新帖一律留 pending 进人工队列'} />
        <Stat label='密钥' value={cfg.has_secret ? '已配置' : '未配置'} tone={cfg.has_secret ? 'neutral' : 'danger'} hint={cfg.has_secret ? '更新于 ' + fmtTime(cfg.secret_updated_at) : '没有密钥时零外呼'} />
        <Stat label='最近成功' value={cfg.last_ok_at ? relTime(cfg.last_ok_at) : '—'} />
        <Stat label='最近失败' value={stopped ? relTime(cfg.last_error_at) : '无'} tone={stopped ? 'danger' : 'neutral'} />
        <Stat label='模型' value={cfg.model || '—'} />
      </StatRow>

      {!canSetting ? <GateNote perm='site.setting'>整屏只读：配置、提示词、密钥与连通测试都要求 site.setting。</GateNote> : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        <Panel title='模型与端点' note='dto.go 的 ConfigView：字段名即契约，PATCH 只写传进来的字段'>
          <div className='mb-2 flex flex-wrap items-center gap-2'>
            <Toggle checked={cfg.enabled} disabled={!canSetting || busy} onChange={(e) => patch({ enabled: e.target.checked })}>
              启用 AI 审核
            </Toggle>
            <span className='text-[11px] text-muted-foreground'>
              关掉后新帖一律留 pending 进人工队列；<b>AI 挂了不挡发帖</b>（d7 硬规则 2）
            </span>
          </div>
          <Select
            type={SelectType.INPUT}
            label='provider'
            data={PROVIDERS}
            selected={PROVIDERS.find((p) => p.key === cfg.provider) ?? null}
            onSelect={(item) => { if (item) patch({ provider: String(item.key) }); }}
          />
          <Input label='base_url' value={cfg.base_url} disabled={!canSetting || busy} onChange={(e) => patch({ base_url: e.target.value })} />
          <Input
            label='model'
            value={cfg.model}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ model: e.target.value })}
            help='审核是分类任务不是推理任务：要快与便宜'
          />
          <div className='mt-2 flex flex-col gap-1'>
            <Toggle checked={cfg.thinking} disabled={!canSetting || busy} onChange={(e) => patch({ thinking: e.target.checked })}>
              thinking（推理模式）
            </Toggle>
            <span className='text-[11px] leading-relaxed text-muted-foreground'>
              关 = 走 Tool Calls + tool_choice=required；开 = 走 JSON Output。两条路不能混（d7 §3.4）。
            </span>
            <Toggle checked={cfg.strict_mode} disabled={!canSetting || busy} onChange={(e) => patch({ strict_mode: e.target.checked })}>
              strict_mode（schema 严格校验）
            </Toggle>
            <span className='text-[11px] leading-relaxed text-muted-foreground'>
              打开后「模型不按 schema 输出」的概率降到接近零，代价是 base_url 要带 /beta（d7 §3.3）。
            </span>
          </div>
          <div className='mt-2'>
            <KV k='最近一次成功' v={cfg.last_ok_at ? fmtTime(cfg.last_ok_at) : '—'} />
            {stopped ? (
              <div className='mt-1 rounded-md border border-border px-2 py-1.5'>
                <span className='flex flex-wrap items-center gap-1.5'>
                  <Clock size={12} aria-hidden className='text-muted-foreground' />
                  <span className='text-[12px] text-foreground'>上一次失败 · {relTime(cfg.last_error_at)}</span>
                  <Pill tone={kindOf(cfg.last_error)}>{kindOf(cfg.last_error) === 'danger' ? '密钥 / 鉴权' : '网络 / 超时'}</Pill>
                </span>
                <p className='break-all text-[11px] leading-relaxed text-muted-foreground'>{cfg.last_error}</p>
                <p className='text-[11px] leading-relaxed text-muted-foreground'>
                  失败只影响这一篇（留在 pending 进人工队列）——<b>AI 挂了不能挡住发帖</b>。
                </p>
              </div>
            ) : null}
          </div>
        </Panel>

        <div className='flex flex-col gap-2'>
          <Panel title='API Key' note='只写不回显：保存后连管理员也看不到，只能替换（d7 §8 验收 12）'>
            <div className='mb-2 flex flex-wrap items-center gap-2'>
              <Pill tone={cfg.has_secret ? 'ok' : 'danger'}>{cfg.has_secret ? '已配置' : '未配置'}</Pill>
              <span className='text-[11px] text-muted-foreground'>
                {cfg.has_secret ? '最后更新于 ' + fmtTime(cfg.secret_updated_at) : '未配置时新帖全部走人工队列，AI 不参与（零外呼）'}
              </span>
            </div>
            <Input
              label={cfg.has_secret ? '新 API Key（粘贴后保存，替换旧的）' : 'API Key'}
              type='password'
              placeholder='sk-…'
              value={secret}
              disabled={!canSetting || busy}
              onChange={(e) => setSecret(e.target.value)}
            />
            <p className='text-[11px] leading-relaxed text-muted-foreground'>
              读接口**永远不返回密钥**（只有 has_secret 与更新时间）。空值不会清掉旧密钥。
            </p>
            <Toolbar className='mt-2'>
              <Button
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(KeyRound)}
                disabled={!canSetting || busy || secret.trim() === ''}
                onClick={() => setConfirmSecret(true)}
              >
                保存密钥
              </Button>
              {secret.trim() === '' ? <DisabledReason>先在输入框里粘贴新密钥</DisabledReason> : null}
            </Toolbar>
          </Panel>

          <Panel
            title='连通测试'
            note='POST /admin/ai/test：**没有入参**，发的是配置里那段提示词 + 一段固定短文本'
            actions={
              <Button
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(PlugZap)}
                loader={busy}
                disabled={!canSetting || busy}
                onClick={onTest}
                data-testid='ai-test-run'
              >
                测试连通
              </Button>
            }
          >
            {testResult ? <TestResult result={testResult} /> : (
              <p className='text-[12px] text-muted-foreground'>
                点一下就走一次真外呼，回执里给 verdict / reason / categories / model / latency_ms / 原始输出。
              </p>
            )}
            <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
              <b>这里没有「拿某篇内容试跑」的表单</b>：那条端点不接受内容入参（aireview/handler.go 的 test 不绑定任何字段）。
              要做得先给 test 加 <code className='rounded-sm bg-muted px-1'>{'{title, content, trigger}'}</code> ——
              这是请求后端改契约，不是前端自己造一个「看起来能试跑」的框。
            </p>
          </Panel>
        </div>
      </div>

      <Panel title='温度与上限' note='只有**输出**上限，没有输入截断：截断会让 AI 只看到半篇、判出来的结论就是错的'>
        <div className='grid gap-3 md:grid-cols-3'>
          <Input
            label='temperature（0–2）'
            value={String(cfg.temperature)}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ temperature: decimal(e.target.value) })}
            help='d7 §3.2 钉死 0：分类任务要确定性，审核结论不该抖。可调只为排查误判'
          />
          <Input
            label='max_output_tokens（64–4096）'
            value={String(cfg.max_output_tokens)}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ max_output_tokens: digits(e.target.value) })}
            help='schema 只有 verdict / reason / categories 三个字段，输出上限与输入大小无关'
          />
          <Input
            label='timeout_ms（1000–60000）'
            value={String(cfg.timeout_ms)}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ timeout_ms: digits(e.target.value) })}
            help='超时按「拿不准」转人工，不无限重试，也绝不因为超时就放行'
          />
        </div>
      </Panel>

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        <Panel title='提示词 · 新建帖（prompt）' note='AI 判「明确合规」才 approved；拿不准一律留 pending 交人工'>
          <Input
            label={'system 提示词 · ' + [...cfg.prompt].length + ' 字'}
            multiline
            rows={10}
            inputClassName='!h-[220px]'
            value={cfg.prompt}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </Panel>
        <Panel title='提示词 · 举报复核（prompt_report）' note='被举报到阈值时用这一套再审一次；复审仍不过或拿不准 → 人工'>
          <Input
            label={'system 提示词 · ' + [...cfg.prompt_report].length + ' 字'}
            multiline
            rows={10}
            inputClassName='!h-[220px]'
            value={cfg.prompt_report}
            disabled={!canSetting || busy}
            onChange={(e) => patch({ prompt_report: e.target.value })}
          />
        </Panel>
      </div>

      <Panel title='这一屏没有做的三件事（后端也还没有）'>
        <ul className='flex flex-col gap-1 text-[12px] leading-relaxed text-muted-foreground'>
          <li>· <b>用量与失败率</b>：没有 <code className='rounded-sm bg-muted px-1'>GET /admin/ai/stats</code>，所以不画那两栏（数据要从 review_events 聚合，端点不存在）。</li>
          <li>· <b>任意内容的试跑</b>：<code className='rounded-sm bg-muted px-1'>POST /admin/ai/test</code> 不接受内容入参（见上）。</li>
          <li>· <b>阈值</b>：d7 §2.2 说放 site_settings，但键值在「站点设置」屏（那一屏按后端给的目录渲染）；AI 屏不重复实现一次。</li>
        </ul>
      </Panel>

      <ConfirmDialog
        show={confirmSecret}
        label='确认保存新的 API Key？'
        danger
        confirmText='保存并替换旧密钥'
        body={
          <span>
            保存后旧密钥立即失效且<b>无法找回</b>（界面只保留「已配置」与更新时间）。
            如果刚在控制台撤销了旧 Key、还没保存新的，审核会退回到人工队列——<b>这不会挡住发帖</b>。
          </span>
        }
        disabledReason={!canSetting ? '本账号没有 site.setting' : undefined}
        onClose={() => setConfirmSecret(false)}
        onConfirm={() => { onSaveSecret(secret.trim()); setSecret(''); setConfirmSecret(false); }}
      />
    </div>
  );
}

/* ── 小工具（纯函数；放在本文件是因为只有这里用）────────────────────────── */

/** 把 last_error 粗分类成「鉴权」与「网络 / 超时」，界面要一眼分得开。 */
function kindOf(text: string): 'danger' | 'warn' {
  return /401|403|auth|key|鉴权|invalid|unauthorized/i.test(text) ? 'danger' : 'warn';
}

function digits(v: string): number {
  return Number(v.replace(/\D/g, '')) || 0;
}

function decimal(v: string): number {
  const n = Number(v.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { AlertTriangle, CheckCircle2, Clock, Download, KeyRound, PlugZap } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ConfirmDialog } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import {
  AI_BUILTIN_PROMPT, AI_CONFIG, AI_PROVIDERS, AI_STATS, AI_TEST_SEQUENCE, AI_THRESHOLDS,
  fmtTime, relTime, type AiConfig, type AiTestResult,
} from '../mock';
import { useCan } from '../mock/perms';

// D7 AI 帖子审核的管理端（d7 §8 + 拍板 §10）。
// 三条设计纪律在这里要看得见：
//   ① **密钥只写不回显**：GET 只给 has_secret 与 secret_updated_at（d7 验收 11 断言响应里没有密钥字段）；
//   ② **AI 失败不挡发帖**：失败率与 last_error 摆在配置旁边，而不是藏进日志；
//   ③ AI 不删内容：界面上没有任何「删除」动作，最多 hidden（可恢复）。
// 权限沿用 site.setting —— 不新造权限点（拍板 §10.3）。

type Thresholds = Record<string, string>;

export function AiReviewScreen() {
  const canSetting = useCan('site.setting');
  // 导出判定明细属「一次导走全站操作痕迹」那一类（拍板 §1.2 把导出单列），本账号没有 → 演示「权限不足不渲染」
  const canExport = useCan('audit.export');

  const [cfg, setCfg] = useState<AiConfig>(AI_CONFIG);
  const [savedCfg, setSavedCfg] = useState<AiConfig>(AI_CONFIG);
  const [thresholds, setThresholds] = useState<Thresholds>(() => Object.fromEntries(AI_THRESHOLDS.map((t) => [t.key, String(t.value)])));
  const [savedThresholds, setSavedThresholds] = useState<Thresholds>(() => Object.fromEntries(AI_THRESHOLDS.map((t) => [t.key, String(t.value)])));
  const [secret, setSecret] = useState('');
  const [confirmSecret, setConfirmSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [testCount, setTestCount] = useState(0);

  const configDirty = JSON.stringify(cfg) !== JSON.stringify(savedCfg);
  const thresholdsDirty = AI_THRESHOLDS.some((t) => thresholds[t.key] !== savedThresholds[t.key]);
  const dirty = configDirty || thresholdsDirty;

  function patch(next: Partial<AiConfig>) {
    setCfg((c) => ({ ...c, ...next }));
  }

  function runTest() {
    setTesting(true);
    setResult(null);
    // mock：连点依次 成功 → 401 → 超时；真实实现是 POST /api/v1/admin/ai/test（不返回密钥）
    window.setTimeout(() => {
      setResult(AI_TEST_SEQUENCE[testCount % AI_TEST_SEQUENCE.length]!);
      setTestCount((n) => n + 1);
      setTesting(false);
    }, 900);
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='AI 审核'
        note='d7：AI 是第一道审核，人是最后一道。新帖先判一次；被举报到阈值用同一套提示词复审；复审仍不过或拿不准 → 人工。'
        actions={
          <>
            <Pill tone={dirty ? 'warn' : 'ok'}>{dirty ? '未保存' : '已保存'}</Pill>
            <Button disabled={!canSetting || !dirty} onClick={() => { setCfg(savedCfg); setThresholds(savedThresholds); }}>放弃改动</Button>
            <Button primary disabled={!canSetting || !dirty} onClick={() => { setSavedCfg(cfg); setSavedThresholds(thresholds); }}>保存全部改动</Button>
          </>
        }
      />

      {!canSetting ? <GateNote perm='site.setting'>整屏只读：配置、密钥、测试连通与阈值都要求 site.setting。</GateNote> : null}

      <div className='grid gap-3 lg:grid-cols-2'>
        {AI_STATS.map((s) => (
          <Panel
            key={s.window}
            title={'用量与失败率 · 最近 ' + s.window}
            note='来自 review_events（source=ai）与 ai_config.last_error'
            actions={<Pill tone={s.failures > 0 ? 'warn' : 'ok'}>{s.failures} 次失败</Pill>}
          >
            <StatRow>
              <Stat label='调用数' value={s.calls} tone='info' />
              <Stat label='通过' value={s.approve} hint={pct(s.approve, s.calls)} />
              <Stat label='拒绝' value={s.reject} tone={s.reject > 0 ? 'danger' : 'neutral'} hint={pct(s.reject, s.calls)} />
              <Stat label='转人工' value={s.review} hint={pct(s.review, s.calls)} />
              <Stat label='平均耗时' value={s.avg_latency_ms + ' ms'} />
              <Stat label='失败' value={s.failures} tone={s.failures > 0 ? 'danger' : 'neutral'} hint={pct(s.failures, s.calls + s.failures)} />
            </StatRow>
            {s.calls === 0 ? <p className='mt-2 text-[11px] text-muted-foreground'>这个窗口内 AI 没有被调用（开关关着或没有新帖）。</p> : null}
          </Panel>
        ))}
      </div>

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        <Panel title='配置（ai_config 单行表）' note='提供商只留两个值：协议相同就不该有第二份实现（d7 §2.1）'>
          <div className='mb-2 flex flex-wrap items-center gap-2'>
            <Toggle checked={cfg.enabled} disabled={!canSetting} onChange={(e) => patch({ enabled: e.target.checked })}>
              启用 AI 审核
            </Toggle>
            <span className='text-[11px] text-muted-foreground'>
              与站点设置里的 ai.review.enabled 是<b>且</b>的关系；关掉后新帖一律留 pending 进人工队列
            </span>
          </div>
          <Select
            type={SelectType.INPUT}
            label='provider'
            data={AI_PROVIDERS}
            selected={AI_PROVIDERS.find((p) => p.key === cfg.provider) ?? null}
            onSelect={(item) => { if (item) patch({ provider: item.key }); }}
          />
          <Input label='base_url' value={cfg.base_url} disabled={!canSetting} onChange={(e) => patch({ base_url: e.target.value })} />
          <Input label='model' value={cfg.model} disabled={!canSetting} onChange={(e) => patch({ model: e.target.value })} />
          <span className='text-[11px] text-muted-foreground'>
            默认 deepseek-chat：审核是分类任务不是推理任务，要快与便宜；以后 DeepSeek 出快速别名，改这里即可
          </span>
          <Input label='timeout_ms（1000–60000）' value={String(cfg.timeout_ms)} disabled={!canSetting} onChange={(e) => patch({ timeout_ms: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          <Input label='max_body_chars（500–20000）' value={String(cfg.max_body_chars)} disabled={!canSetting} onChange={(e) => patch({ max_body_chars: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          <span className='text-[11px] text-muted-foreground'>
            只送 title + 1 楼正文的纯文本，截断到这里；<b>不送图片、不送作者信息</b>
          </span>
          <Input
            label='提示词（留空 = 用内置默认）'
            multiline
            rows={8}
            // Ring 的 textarea 高度由它自己的 CSS 决定，rows 不生效 → 显式给高度
            inputClassName='!h-[176px]'
            value={cfg.prompt}
            disabled={!canSetting}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
          <div className='mt-1 rounded-md bg-muted/50 px-2 py-1.5'>
            <span className='text-[11px] font-medium text-muted-foreground'>内置默认提示词（只读；上面的输入框留空时生效）</span>
            <p className='mt-1 whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground'>{AI_BUILTIN_PROMPT}</p>
          </div>
          <KV
            k='内置默认提示词'
            v={cfg.prompt.trim() === '' ? '正在使用' : '已被自定义覆盖'}
            hint='宁可放过，不可错杀——误杀正常帖的代价大于放过边缘内容（d7 §4）'
          />
        </Panel>

        <div className='flex flex-col gap-3'>
          <Panel title='API Key' note='只写不回显：保存后连管理员也看不到，只能替换（d7 §8 验收 11）'>
            <div className='mb-2 flex flex-wrap items-center gap-2'>
              <Pill tone={cfg.has_secret ? 'ok' : 'danger'}>{cfg.has_secret ? '已配置' : '未配置'}</Pill>
              <span className='text-[11px] text-muted-foreground'>
                {cfg.has_secret ? '最后更新于 ' + fmtTime(cfg.secret_updated_at) : '未配置时新帖全部走人工队列，AI 不参与'}
              </span>
            </div>
            <Input
              label={cfg.has_secret ? '新 API Key（粘贴后保存，替换旧的）' : 'API Key'}
              type='password'
              placeholder='sk-…'
              value={secret}
              disabled={!canSetting}
              onChange={(e) => setSecret(e.target.value)}
            />
            <p className='text-[11px] leading-relaxed text-muted-foreground'>
              密钥加密存储（chacha20poly1305，与发信凭据同一把主密钥）；<b>保存后不可查看，只能替换</b>。
              POST /api/v1/admin/ai/config/secret 的 body 里只有新密钥，读接口永远不返回它。
            </p>
            <Toolbar className='mt-2'>
              <Button
                icon={icon16(KeyRound)}
                disabled={!canSetting || secret.trim() === ''}
                onClick={() => setConfirmSecret(true)}
              >
                保存密钥
              </Button>
              {secret.trim() === '' ? <DisabledReason>先在输入框里粘贴新密钥；空值不会清掉旧密钥</DisabledReason> : null}
            </Toolbar>
            {cfg.has_secret && secret.trim() === '' ? (
              <p className='text-[11px] text-muted-foreground'>输入框留空 —— 界面上不会把已保存的密钥填回来。</p>
            ) : null}
          </Panel>

          <Panel
            title='测试连通'
            note='POST /api/v1/admin/ai/test：真实调一次，返回耗时与模型原始回执（不含密钥）'
            actions={<Button icon={icon16(PlugZap)} loader={testing} disabled={!canSetting} onClick={runTest}>测试连通</Button>}
          >
            {result === null && !testing ? (
              <p className='text-[12px] text-muted-foreground'>还没测过。上次成功：{relTime(cfg.last_ok_at)}。</p>
            ) : null}
            {testing ? <p className='text-[12px] text-muted-foreground'>正在请求 {cfg.base_url}/chat/completions …</p> : null}
            {result ? <TestResult result={result} /> : null}
            {cfg.last_error ? (
              <div className='mt-2 rounded-md border border-border px-2 py-1.5'>
                <span className='flex items-center gap-1.5'>
                  <Clock size={12} aria-hidden className='text-muted-foreground' />
                  <span className='text-[12px] text-foreground'>上一次失败 · {relTime(cfg.last_error_at)}</span>
                  <Pill tone={kindOf(cfg.last_error)}>{kindOf(cfg.last_error) === 'danger' ? '密钥/鉴权' : '网络/超时'}</Pill>
                </span>
                <p className='text-[11px] leading-relaxed text-muted-foreground'>{cfg.last_error}</p>
                <p className='text-[11px] leading-relaxed text-muted-foreground'>
                  失败只影响这一篇（留在 pending 进人工队列）——<b>AI 挂了不能挡住发帖</b>（d7 硬规则 2）。
                </p>
              </div>
            ) : null}
          </Panel>
        </div>
      </div>

      <Panel
        title='阈值'
        note='放 site_settings（d7 §2.2）：管理员可改、不用发版'
        actions={<Button primary disabled={!canSetting || !thresholdsDirty} onClick={() => setSavedThresholds(thresholds)}>保存阈值</Button>}
      >
        <div className='grid gap-3 md:grid-cols-3'>
          {AI_THRESHOLDS.map((t) => (
            <div key={t.key} className='flex flex-col gap-1'>
              <Input
                label={t.label}
                value={thresholds[t.key] ?? ''}
                disabled={!canSetting}
                onChange={(e) => setThresholds((v) => ({ ...v, [t.key]: e.target.value.replace(/\D/g, '') }))}
              />
              <span className='text-[11px] leading-relaxed text-muted-foreground'>
                <code className='rounded-sm bg-muted px-1'>{t.key}</code>
                {t.hint}（范围 {t.min}–{t.max}）
              </span>
            </div>
          ))}
        </div>
        <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
          链路：新帖 → AI 判 → 未处理举报累计到 {thresholds['ai.review.report_threshold_1'] || '3'} → AI 复审（同提示词 + 「已被 N 人举报，重点看是否违规」）
          → 复审仍不过或拿不准 → 人工；累计到 {thresholds['ai.review.report_threshold_2'] || '5'} → <b>直接人工，不再调 AI</b>。
          单帖每天最多调 {thresholds['ai.review.daily_limit_per_topic'] || '3'} 次。
        </p>
      </Panel>

      <Panel title='判定明细导出'>
        {canExport ? (
          <Toolbar>
            <Button icon={icon16(Download)}>导出最近 7 天判定明细（CSV）</Button>
          </Toolbar>
        ) : (
          <GateNote perm='audit.export'>
            「导出最近 7 天判定明细」不渲染：判定事件属于审计类数据，导出权限单列（拍板 §1.2：能一次导走全站操作痕迹）。
            这一屏只做只读展示，导出是另一个入口。
          </GateNote>
        )}
      </Panel>

      <ConfirmDialog
        show={confirmSecret}
        label='确认保存新的 API Key？'
        danger
        confirmText='保存并替换旧密钥'
        body={
          <span>
            保存后旧密钥立即失效且<b>无法找回</b>（界面只保留「已配置」与更新时间）。
            如果刚在 DeepSeek 控制台撤销了旧 Key、还没来得及保存新的，审核会先退回到人工队列——这不会挡住发帖。
          </span>
        }
        disabledReason={!canSetting ? '本账号没有 site.setting' : undefined}
        onClose={() => setConfirmSecret(false)}
        onConfirm={() => {
          setCfg((c) => ({ ...c, has_secret: true, secret_updated_at: new Date().toISOString() }));
          setSavedCfg((c) => ({ ...c, has_secret: true, secret_updated_at: new Date().toISOString() }));
          setSecret('');
          setConfirmSecret(false);
        }}
      />
    </div>
  );
}

/** 三种回执**长得不一样**：一眼能分出「密钥错（401）」与「网络/超时」。 */
function TestResult({ result }: { result: AiTestResult }) {
  if (result.kind === 'ok') {
    return (
      <div className='rounded-md border border-border px-2 py-2'>
        <span className='flex flex-wrap items-center gap-1.5'>
          <CheckCircle2 size={14} aria-hidden className='text-primary' />
          <Pill tone='ok'>连通成功</Pill>
          <span className='text-[12px] text-foreground'>耗时 {result.latency_ms} ms · {result.model}</span>
        </span>
        <p className='mt-2 break-all font-mono text-[11px] text-muted-foreground'>{result.raw}</p>
        <p className='text-[11px] text-muted-foreground'>回执可解析：verdict / reason / categories 三个字段齐全，说明 JSON 模式生效。</p>
      </div>
    );
  }
  if (result.kind === 'auth') {
    return (
      <div className='rounded-md border border-destructive/40 bg-destructive/8 px-2 py-2'>
        <span className='flex flex-wrap items-center gap-1.5'>
          <AlertTriangle size={14} aria-hidden className='text-destructive' />
          <Pill tone='danger'>密钥错 · HTTP {result.status}</Pill>
          <span className='text-[12px] text-foreground'>鉴权失败，不是网络问题</span>
        </span>
        <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>{result.message}</p>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>处理：去 DeepSeek 控制台重新生成，粘贴到上面的密钥框保存（会走二次确认）。</p>
      </div>
    );
  }
  return (
    <div className='rounded-md border border-border bg-muted/50 px-2 py-2'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <Clock size={14} aria-hidden className='text-muted-foreground' />
        <Pill tone='warn'>网络 / 超时 · {result.timeout_ms} ms</Pill>
        <span className='text-[12px] text-foreground'>没拿到回执</span>
      </span>
      <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>{result.message}</p>
      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        处理：先确认 base_url 与本机出网；确实慢就把 timeout_ms 调大（当前 {AI_CONFIG.timeout_ms} ms），别急着换密钥。
      </p>
    </div>
  );
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

/** 把 last_error 粗分类成「鉴权」与「网络/超时」，界面要一眼分得开。 */
function kindOf(error: string): 'danger' | 'warn' {
  return /401|403|auth|key|鉴权|invalid/i.test(error) ? 'danger' : 'warn';
}
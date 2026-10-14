import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { AlertTriangle, CheckCircle2, Clock, FlaskConical, PlugZap } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { Panel, Pill, Toolbar } from '../bits';
import {
  AI_CATEGORY_LABEL, AI_SCENARIOS, AI_TEST_SEQUENCE, AI_VERDICT_LABEL, AI_TRIAL_SOURCES,
  composeUserMessage, effectivePrompt, runTrial, trialSource,
  type AiConfig, type AiScenario, type AiTestResult, type AiTrialResult,
} from '../mock';

// 试跑与连通。
// 为什么要有**试跑**（d7 §8 的「测试连通」只发一段固定短文本）：提示词是有编辑框的，改完必须能立刻看见
// 「这段内容会被判成什么」——否则调提示词就是盲改。这里发出去的就是界面上那两段（system + user），不截断（§2.4）。
// 连通那一栏保留：它回答的是另一个问题（密钥/网络到底通不通），三种回执长得**不一样**，一眼能分开。
export function AiTrial({ cfg, canRun }: { cfg: AiConfig; canRun: boolean }) {
  const firstKey = AI_TRIAL_SOURCES[0]?.key ?? '';
  const [sample, setSample] = useState(firstKey);
  const [scenario, setScenario] = useState<AiScenario>('create');
  const [reportCount, setReportCount] = useState(3);
  const [title, setTitle] = useState(() => trialSource(firstKey).title);
  const [body, setBody] = useState(() => trialSource(firstKey).body);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiTrialResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testCount, setTestCount] = useState(0);

  const system = effectivePrompt(cfg, scenario, reportCount);
  const user = composeUserMessage(title, body);

  /** 改了输入就把上一次的回执清掉：留着一份对不上当前内容的判定，比没有更糟。 */
  function edit(next: Partial<{ title: string; body: string; scenario: AiScenario; reportCount: number }>) {
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);
    if (next.scenario !== undefined) setScenario(next.scenario);
    if (next.reportCount !== undefined) setReportCount(next.reportCount);
    setResult(null);
  }

  function doTrial() {
    setRunning(true);
    setResult(null);
    // mock：真实现是 POST /api/v1/admin/ai/test {title, content, trigger}
    window.setTimeout(() => {
      setResult(runTrial({ scenario, title, body, report_count: reportCount }));
      setRunning(false);
    }, 900);
  }

  function doTest() {
    setTesting(true);
    setTest(null);
    // mock：连点依次 成功 → 401 → 超时，方便一次看全三种形态（真实实现只返回真结果）
    window.setTimeout(() => {
      setTest(AI_TEST_SEQUENCE[testCount % AI_TEST_SEQUENCE.length]!);
      setTestCount((n) => n + 1);
      setTesting(false);
    }, 900);
  }

  return (
    <Panel
      title='试跑与连通'
      note='POST /api/v1/admin/ai/test：用一段**真实内容**走一次完整判定（d7 §8）。输入不截断（§2.4），发出去的就是下面预览里的两段。'
      actions={
        <>
          <Pill tone={cfg.thinking ? 'warn' : 'ok'}>{cfg.thinking ? 'thinking：JSON Output 路径' : 'thinking：Tool Calls 路径'}</Pill>
          <Pill tone='outline'>{'temperature ' + cfg.temperature + ' · max_tokens ' + cfg.max_output_tokens}</Pill>
        </>
      }
    >
      <Toolbar className='mb-2'>
        <Select
          type={SelectType.INPUT}
          label='试跑内容（取自待审队列）'
          data={AI_TRIAL_SOURCES}
          selected={AI_TRIAL_SOURCES.find((s) => s.key === sample) ?? null}
          onSelect={(item) => {
            if (!item) return;
            const key = String(item.key);
            setSample(key);
            edit({ title: trialSource(key).title, body: trialSource(key).body });
          }}
        />
        <Select
          type={SelectType.INPUT}
          label='场景（决定用哪套提示词）'
          data={AI_SCENARIOS.map((s) => ({ key: s.key, label: s.label + '（' + s.trigger + '）' }))}
          selected={{ key: scenario, label: AI_SCENARIOS.find((s) => s.key === scenario)!.label }}
          onSelect={(item) => { if (item) edit({ scenario: String(item.key) as AiScenario }); }}
        />
        {scenario === 'report' ? (
          <Input
            label='已被举报数'
            value={String(reportCount)}
            disabled={!canRun}
            onChange={(e) => edit({ reportCount: Number(e.target.value.replace(/\D/g, '')) || 0 })}
          />
        ) : null}
      </Toolbar>

      <Input label='标题' value={title} disabled={!canRun} onChange={(e) => edit({ title: e.target.value })} />
      <Input
        label={'正文（原样发送，不截断 · ' + [...body].length + ' 字）'}
        multiline
        rows={6}
        inputClassName='!h-[132px]'
        value={body}
        disabled={!canRun}
        onChange={(e) => edit({ body: e.target.value })}
      />

      <div className='mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5'>
        <span className='text-[11px] font-medium text-muted-foreground'>请求预览（点试跑就发这两段）</span>
        <p className='mt-1 text-[10px] text-muted-foreground'>
          {'model ' + cfg.model + ' · temperature ' + cfg.temperature + ' · max_tokens ' + cfg.max_output_tokens
            + ' · ' + (cfg.thinking ? 'response_format=json_object' : 'tool_choice=required')
            + ' · strict_mode ' + (cfg.strict_mode ? 'on' : 'off')}
        </p>
        <p className='mt-1 text-[11px] font-medium text-foreground'>system</p>
        <p className='m-0 max-h-[104px] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground'>{system}</p>
        <p className='mt-1 text-[11px] font-medium text-foreground'>user</p>
        <p className='m-0 max-h-[104px] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground'>{user}</p>
      </div>

      <Toolbar className='mt-2'>
        <Button primary inline={false} height={ControlsHeight.S} icon={icon16(FlaskConical)} loader={running} disabled={!canRun} data-testid='ai-trial-run' onClick={doTrial}>
          试跑这段内容
        </Button>
        <Button inline={false} height={ControlsHeight.S} icon={icon16(PlugZap)} loader={testing} disabled={!canRun} data-testid='ai-test-run' onClick={doTest}>
          测试连通
        </Button>
        {!canRun ? <span className='text-[11px] text-muted-foreground'>本账号没有 site.setting：只能看，不能发外呼</span> : null}
      </Toolbar>

      {running ? <p className='mt-2 text-[12px] text-muted-foreground'>正在请求 {cfg.base_url}/chat/completions …</p> : null}
      {result ? <TrialResult result={result} /> : null}
      {testing ? <p className='mt-2 text-[12px] text-muted-foreground'>正在请求 {cfg.base_url}/chat/completions …</p> : null}
      {test ? <TestResult result={test} /> : null}
    </Panel>
  );
}

/** 试跑回执：verdict / reason / categories 三个字段齐全，说明返回值可解析（d7 §3.5）。 */
function TrialResult({ result }: { result: AiTrialResult }) {
  const tone = result.verdict === 'approve' ? 'ok' : result.verdict === 'reject' ? 'danger' : 'warn';
  return (
    <div data-testid='ai-trial-result' className='mt-2 rounded-md border border-border px-2 py-2'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <Pill tone={tone}>{AI_VERDICT_LABEL[result.verdict]}</Pill>
        <span className='text-[12px] text-foreground'>{result.model} · {result.latency_ms} ms</span>
        {result.categories.length === 0 ? <span className='text-[11px] text-muted-foreground'>categories 为空数组</span> : null}
      </span>
      <p className='mt-1.5 text-[12px] leading-relaxed text-foreground'>{result.reason}</p>
      {result.categories.length > 0 ? (
        <span className='mt-1 flex flex-wrap items-center gap-1'>
          {result.categories.map((c) => (
            <span key={c} className='rounded-sm bg-muted px-1 text-[10px] text-muted-foreground'>{AI_CATEGORY_LABEL[c]}</span>
          ))}
        </span>
      ) : null}
      <p className='mt-1.5 break-all font-mono text-[11px] text-muted-foreground'>{result.raw}</p>
      <p className='mt-1 text-[11px] leading-relaxed text-muted-foreground'>
        结论怎么落地（照实现，不照 d7 §1 那行字）：approve → review_state=approved；<b>reject 只把理由写进 review_note，
        状态仍是 pending，由人按「不通过」</b>；review → 留在 pending 进人工队列。AI 永远不删内容。
      </p>
    </div>
  );
}

/** 三种回执**长得不一样**：一眼能分出「密钥错（401）」与「网络/超时」。 */
function TestResult({ result }: { result: AiTestResult }) {
  if (result.kind === 'ok') {
    return (
      <div data-testid='ai-test-result' className='mt-2 rounded-md border border-border px-2 py-2'>
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
      <div className='mt-2 rounded-md border border-destructive/40 bg-destructive/8 px-2 py-2'>
        <span className='flex flex-wrap items-center gap-1.5'>
          <AlertTriangle size={14} aria-hidden className='text-destructive' />
          <Pill tone='danger'>密钥错 · HTTP {result.status}</Pill>
          <span className='text-[12px] text-foreground'>鉴权失败，不是网络问题</span>
        </span>
        <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>{result.message}</p>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>处理：去 DeepSeek 控制台重新生成，粘贴到下面的密钥框保存（会走二次确认）。</p>
      </div>
    );
  }
  return (
    <div className='mt-2 rounded-md border border-border bg-muted/50 px-2 py-2'>
      <span className='flex flex-wrap items-center gap-1.5'>
        <Clock size={14} aria-hidden className='text-muted-foreground' />
        <Pill tone='warn'>网络 / 超时 · {result.timeout_ms} ms</Pill>
        <span className='text-[12px] text-foreground'>没拿到回执</span>
      </span>
      <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>{result.message}</p>
      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        处理：先确认 base_url 与本机出网；确实慢就把 timeout_ms 调大，别急着换密钥。失败只影响这一篇（留 pending 进人工队列）——AI 挂了不能挡住发帖。
      </p>
    </div>
  );
}

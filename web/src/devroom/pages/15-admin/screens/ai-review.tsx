import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Clock, Download, KeyRound } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ConfirmDialog } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { AiHistory } from './ai-history';
import { AiPrompts } from './ai-prompts';
import { AiTrial } from './ai-trial';
import { AI_CONFIG, AI_PROVIDERS, AI_STATS, AI_THRESHOLDS, fmtTime, relTime, type AiConfig } from '../mock';
import { useCan } from '../mock/perms';

// D7 AI 审核编辑器（管理端）。唯一真源：完全重构/后端设计/d7-ai-review.md。
// 这一屏回答四个问题，顺序就是它们的顺序（照 open-webui 的提示词编辑器学的信息架构 ——
// 「模型 → 提示词 → 试跑 → 历史」）：**用哪个模型、喂它什么话、它会怎么判、它以前判过什么**。
//
// 三条设计纪律在这里要看得见：
//   ① **密钥只写不回显**：GET 只给 has_secret 与 secret_updated_at（d7 验收 11 断言响应里没有密钥字段）；
//   ② **AI 失败不挡发帖**：失败率与 last_error 摆在配置旁边，而不是藏进日志；
//   ③ AI 不删内容：界面上没有任何「删除」动作，最多 hidden（可恢复）。
// 权限沿用 site.setting —— 不新造权限点（d7 §8）。
//
// 2026-10-14 与旧版的两处**按文档修正**（旧 mock 与 d7 相反）：
//   · max_body_chars（正文截断 4000）已删 —— d7 §2.4 明确不截断，只有输出上限 max_output_tokens；
//   · model 默认 deepseek-flash —— d7 §2.3 明确 deepseek-chat 已下线。

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

  const configDirty = JSON.stringify(cfg) !== JSON.stringify(savedCfg);
  const thresholdsDirty = AI_THRESHOLDS.some((t) => thresholds[t.key] !== savedThresholds[t.key]);
  const dirty = configDirty || thresholdsDirty;

  function patch(next: Partial<AiConfig>) {
    setCfg((c) => ({ ...c, ...next }));
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='AI 审核编辑器'
        note='d7：AI 是第一道审核，人是最后一道。新帖先判一次；被举报到阈值用「举报复核」那套提示词再审一次；复审仍不过或拿不准 → 人工。'
        actions={
          <>
            <Pill tone={dirty ? 'warn' : 'ok'}>{dirty ? '未保存' : '已保存'}</Pill>
            <Button disabled={!canSetting || !dirty} onClick={() => { setCfg(savedCfg); setThresholds(savedThresholds); }}>放弃改动</Button>
            <Button primary disabled={!canSetting || !dirty} onClick={() => { setSavedCfg(cfg); setSavedThresholds(thresholds); }}>保存全部改动</Button>
          </>
        }
      />

      {!canSetting ? <GateNote perm='site.setting'>整屏只读：配置、提示词、密钥、试跑与阈值都要求 site.setting。</GateNote> : null}

      <Panel
        title='与当前后端实现的对齐（接入单）'
        note='本屏按 d7 设计（d7 有 ai_config 表结构与四个 admin 端点）；后端**现在只落地了 cron 审核那一段**，下面几项还不是接口。'
      >
        <KV k='配置来源' v='YAML / env（FORUM_AI__*）' hint='ai_config 单行表还没建 → 这一屏的编辑框暂时没有端点可存' />
        <KV k='提示词' v='单条 config.AI.prompt' hint='两套（新建帖 / 举报复核）是本屏新提的，需要 ai_config 加 prompt / prompt_report 两列' />
        <KV k='调用形状' v='response_format=json_object · temperature=0' hint='POST {endpoint}/v1/chat/completions（注意实现里带 /v1，与 d7 §3.2 写的 base_url + /chat/completions 不一致）' />
        <KV k='回执' v='{"ok": bool, "reason": string}' hint='d7 要的是三值 verdict + categories；实现是二值，于是「违规」与「拿不准」现在落在同一档' />
        <KV k='判定落库' v='ok → review_state=approved；否则只写 review_note + ai_review_note，状态仍 pending' hint='与 d7 §1 那行「判违规 → rejected」不同：实现是「只有明确说合规才放行」，本屏按**实现**写' />
        <KV k='审核历史' v='review_events 还没建表' hint='本屏的历史是把 15-admin 帖子审核队列里那份假数据摊平成全站视图，不是接口' />
        <KV k='admin 端点' v='GET/PATCH /admin/ai/config · POST /admin/ai/config/secret · POST /admin/ai/test · GET /admin/ai/stats' hint='四个都还没做（d7 §8）' />
      </Panel>

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
        <Panel title='模型与端点' note='ai_config 单行表（d7 §2.1）。提供商只留两个值：协议相同就不该有第二份实现（§2.1）'>
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
            onSelect={(item) => { if (item) patch({ provider: item.key as AiConfig['provider'] }); }}
          />
          <Input label='base_url' value={cfg.base_url} disabled={!canSetting} onChange={(e) => patch({ base_url: e.target.value })} />
          <Input
            label='model'
            value={cfg.model}
            disabled={!canSetting}
            onChange={(e) => patch({ model: e.target.value })}
            help='默认 deepseek-flash：审核是分类任务不是推理任务，要快与便宜。deepseek-chat 已下线，别填它（d7 §2.3）'
          />
          <div className='mt-2 flex flex-col gap-1'>
            <Toggle checked={cfg.thinking} disabled={!canSetting} onChange={(e) => patch({ thinking: e.target.checked })}>
              thinking（推理模式）
            </Toggle>
            <span className='text-[11px] leading-relaxed text-muted-foreground'>
              关（默认）= 走 Tool Calls + tool_choice=required，读 tool_calls[0].function.arguments；
              开 = 走 JSON Output，读 message.content。<b>思考模式下官方不支持 tool_choice=required</b>，所以两条路不能混（d7 §3.4）。
              慢一点也贵一点，只在转人工比例偏高时开。
            </span>
            <Toggle checked={cfg.strict_mode} disabled={!canSetting} onChange={(e) => patch({ strict_mode: e.target.checked })}>
              strict_mode（schema 严格校验）
            </Toggle>
            <span className='text-[11px] leading-relaxed text-muted-foreground'>
              打开后「模型不按 schema 输出」的概率降到接近零，代价是 base_url 必须用 <code className='rounded-sm bg-muted px-1'>https://api.deepseek.com/beta</code>（d7 §3.3）。
            </span>
          </div>
          <div className='mt-2'>
            <KV k='最近一次成功' v={relTime(cfg.last_ok_at)} />
            {cfg.last_error ? (
              <div className='mt-1 rounded-md border border-border px-2 py-1.5'>
                <span className='flex flex-wrap items-center gap-1.5'>
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
          </div>
        </Panel>

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
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(KeyRound)}
              disabled={!canSetting || secret.trim() === ''}
              onClick={() => setConfirmSecret(true)}
            >
              保存密钥
            </Button>
            {secret.trim() === '' ? <DisabledReason>先在输入框里粘贴新密钥；空值不会清掉旧密钥</DisabledReason> : null}
          </Toolbar>
        </Panel>
      </div>

      <Panel title='温度与上限' note='d7 §2.4 只有**输出**上限，没有输入截断：截断会让 AI 只看到半篇、判出来的结论就是错的'>
        <div className='grid gap-3 md:grid-cols-3'>
          <Input
            label='temperature（0–2）'
            value={String(cfg.temperature)}
            disabled={!canSetting}
            onChange={(e) => patch({ temperature: decimal(e.target.value) })}
            help='d7 §3.2 钉死 0：分类任务要确定性，审核结论不该抖。做成可调只为排查误判，默认仍是 0'
          />
          <Input
            label='max_output_tokens（64–4096）'
            value={String(cfg.max_output_tokens)}
            disabled={!canSetting}
            onChange={(e) => patch({ max_output_tokens: digits(e.target.value) })}
            help='默认 512：schema 只有 verdict / reason / categories 三个字段，输出上限与输入大小无关'
          />
          <Input
            label='timeout_ms（1000–60000）'
            value={String(cfg.timeout_ms)}
            disabled={!canSetting}
            onChange={(e) => patch({ timeout_ms: digits(e.target.value) })}
            help='默认 20000：超时按「拿不准」转人工，不无限重试，也绝不因为超时就放行'
          />
        </div>
      </Panel>

      <AiPrompts cfg={cfg} canEdit={canSetting} onPatch={patch} />

      <AiTrial cfg={cfg} canRun={canSetting} />

      <AiHistory />

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
          链路：新帖 → AI 判（create）→ 未处理举报累计到 {thresholds['ai.review.report_threshold_1'] || '3'} → 用「举报复核」那套再审一次（report）
          → 复审仍不过或拿不准 → 人工；累计到 {thresholds['ai.review.report_threshold_2'] || '5'} → <b>直接人工，不再调 AI</b>。
          单帖每天最多调 {thresholds['ai.review.daily_limit_per_topic'] || '3'} 次。人工判过的帖子，AI 重放会直接返回，绝不覆盖人工判定（d7 §6 幂等）。
        </p>
      </Panel>

      <Panel title='判定明细导出'>
        {canExport ? (
          <Toolbar>
            <Button inline={false} height={ControlsHeight.S} icon={icon16(Download)}>导出最近 7 天判定明细（CSV）</Button>
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

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

/** 把 last_error 粗分类成「鉴权」与「网络/超时」，界面要一眼分得开。 */
function kindOf(error: string): 'danger' | 'warn' {
  return /401|403|auth|key|鉴权|invalid/i.test(error) ? 'danger' : 'warn';
}

function digits(v: string): number {
  return Number(v.replace(/\D/g, '')) || 0;
}

function decimal(v: string): number {
  const n = Number(v.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

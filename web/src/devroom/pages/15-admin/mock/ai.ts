import type { AiCategory, AiVerdict } from './ai-types';
import { REVIEW_EVENTS, REVIEW_QUEUE, type ReviewEvent } from './content';

// D7 AI 帖子审核的**管理端数据层**。
// 唯一真源：完全重构/后端设计/d7-ai-review.md —— 配置表 §2.1 / 阈值 §2.2 / 提示词 §4 / 事件表 §5.2 / 端点 §8。
// 字段名逐字照 d7，不照 mock 猜：provider / base_url / model / thinking / prompt / timeout_ms /
// max_output_tokens / strict_mode / has_secret / secret_updated_at / last_ok_at / last_error / last_error_at。
//
// 2026-10-14 修正旧 mock 里两处**与 d7 相反**的值（这次是照文档，不是照上一版界面）：
//   · model 原写 deepseek-chat —— d7 §2.3 明确该名字**已下线**（请求会被 Flash 接管并按 Flash 计费），默认必须是 deepseek-flash；
//   · max_body_chars 原写 4000 —— d7 §2.4 明确「**不做任何截断**」：截断会让 AI 只看到半篇、判出来的结论就是错的，
//     真正的上限只有**输出**的 max_output_tokens（64–4096）。

export type AiProvider = 'deepseek' | 'openai_compatible';
/** d7 §1：同一套模型，两个入口 —— 新帖首发（create）与被举报到阈值后的复核（report）。 */
export type AiScenario = 'create' | 'report';
/** GET /api/v1/admin/ai/config。**密钥永不回显**：只有 has_secret 与 secret_updated_at（d7 §8）。 */
export type AiConfig = {
  enabled: boolean;
  provider: AiProvider;
  base_url: string;
  model: string;
  /** d7 §3.4：false = 走 Tool Calls（快）；true = 走 JSON Output 的推理模式。 */
  thinking: boolean;
  /** d7 §3.3：strict 要求 base_url 用 /beta 域名，所以默认关。 */
  strict_mode: boolean;
  timeout_ms: number;
  /** d7 §2.1：64–4096；**输入不截断**，只有输出有这个上限。 */
  max_output_tokens: number;
  /** d7 §3.2 把 temperature 钉死为 0（分类任务要确定性）；这里可调只为排查误判，默认仍是 0。 */
  temperature: number;
  /** 新建帖审核的提示词；留空 = 用内置默认（d7 §4）。 */
  prompt: string;
  /** 举报复核的提示词；留空 = 内置默认（= §4 那套 + 一句「已被 N 人举报」）。 */
  prompt_report: string;
  has_secret: boolean;
  secret_updated_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
};

export const AI_CONFIG: AiConfig = {
  enabled: true,
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: false,
  strict_mode: false,
  timeout_ms: 20000,
  max_output_tokens: 512,
  temperature: 0,
  prompt: '',
  prompt_report: '',
  has_secret: true,
  secret_updated_at: '2026-10-01T03:20:00Z',
  last_ok_at: '2026-10-12T13:20:00Z',
  last_error: '超时 20000ms（POST https://api.deepseek.com/chat/completions）',
  last_error_at: '2026-10-11T22:10:00Z',
};

export const AI_PROVIDERS: { key: AiProvider; label: string }[] = [
  { key: 'deepseek', label: 'deepseek（默认）' },
  { key: 'openai_compatible', label: 'openai_compatible（任何兼容 /chat/completions 的服务）' },
];

export const AI_SCENARIOS: { key: AiScenario; label: string; trigger: string; editorHint: string }[] = [
  {
    key: 'create', label: '新建帖审核', trigger: 'trigger = create',
    editorHint: '每个新帖的第一道判定（作者 trusted 免审的除外）。留空 = 用内置默认。',
  },
  {
    key: 'report', label: '举报复核', trigger: 'trigger = report',
    editorHint: '未处理举报累计到阈值 1 时再审一次。留空 = 内置默认（新建帖那套 + 一句「已被 N 人举报」）。',
  },
];

// d7 §4 的内置默认提示词（ai_config.prompt 留空时生效）。
// 用 Tool Calls 取结构化结论时提示词里**不需要出现 json 字样**；只有退回 JSON Output 的
// openai_compatible 兼容模式才要补「以 JSON 输出」并给样例（d7 §4 末段）。
export const AI_BUILTIN_PROMPTS: Record<AiScenario, string> = {
  create: [
    '你是中文社区（星际争霸战役作者社区）的内容审核员。判断下面这篇帖子是否适合公开发布。',
    '',
    '拒绝（reject）—— 只在这些情况：',
    '  · 广告、推广、拉群、卖号、引流到站外交易；',
    '  · 辱骂、人身攻击、地域/民族歧视、色情、暴力威胁；',
    '  · 违法违规内容；',
    '  · 与本站主题完全无关的刷屏内容。',
    '',
    '拿不准（review）—— 下列情况必须交人工，不要自己决定：',
    '  · 你不确定是否违规；',
    '  · 内容涉及争议话题、指控某个人、或涉及真实身份；',
    '  · 正文为空、噪声、或明显是机器生成的乱码；',
    '  · 任何你无法判断的情境。',
    '',
    '其余一律通过（approve）。**宁可放过，不可错杀**——本站是创作者社区，误杀一篇正常帖子的代价远大于放过一篇边缘内容。',
    '',
    '理由（reason）用中文，不超过 60 字，直接说原因，不要复述规则。',
    '调用 submit_review 提交结论。',
  ].join('\n'),
  report: '',
};
// 举报复核 = 新建帖那套 + 一句（d7 §1）。N 由任务在运行时填入。
AI_BUILTIN_PROMPTS.report = AI_BUILTIN_PROMPTS.create + '\n\n该帖已被 N 人举报，重点看是否违规。';

/** 生效的提示词：自定义优先，留空回落内置默认。 */
export function effectivePrompt(cfg: AiConfig, scenario: AiScenario, reportCount = 0): string {
  const custom = (scenario === 'create' ? cfg.prompt : cfg.prompt_report).trim();
  if (custom !== '') return custom;
  const base = AI_BUILTIN_PROMPTS[scenario];
  return scenario === 'report' ? base.replace('N 人', reportCount + ' 人') : base;
}

/** 提示词来自哪里 —— 界面上要一眼看得出「我正在用内置默认」还是「已被自定义覆盖」（d7 §4）。 */
export function promptSource(cfg: AiConfig, scenario: AiScenario): 'custom' | 'builtin' {
  return (scenario === 'create' ? cfg.prompt : cfg.prompt_report).trim() === '' ? 'builtin' : 'custom';
}

/** d7 §3.2 的 user 消息：只有标题与正文，**不放作者信息**（§11）。正文不截断（§2.4）。 */
export function composeUserMessage(title: string, body: string): string {
  return '标题：' + title + '\n\n正文：\n' + body;
}

/** GET /api/v1/admin/ai/stats：来自 review_events（source='ai'）与 ai_config.last_error。 */
export type AiStats = {
  window: '24h' | '7d';
  calls: number;
  approve: number;
  reject: number;
  /** 转人工（verdict=review） */
  review: number;
  avg_latency_ms: number;
  failures: number;
};

export const AI_STATS: AiStats[] = [
  { window: '24h', calls: 128, approve: 109, reject: 6, review: 13, avg_latency_ms: 1120, failures: 3 },
  { window: '7d', calls: 862, approve: 742, reject: 41, review: 79, avg_latency_ms: 1180, failures: 17 },
];

/** 阈值放 site_settings（d7 §2.2），管理员可改、不用发版。 */
export type AiThreshold = { key: string; label: string; value: number; min: number; max: number; hint: string };

export const AI_THRESHOLDS: AiThreshold[] = [
  { key: 'ai.review.report_threshold_1', label: '举报 → AI 复审阈值', value: 3, min: 1, max: 50, hint: '未处理举报累计到这么多条 → 用「举报复核」那套提示词再审一次' },
  { key: 'ai.review.report_threshold_2', label: '举报 → 直接转人工阈值', value: 5, min: 2, max: 100, hint: '累计到这么多条 → 直接进人工队列，不再调 AI（防举报风暴打爆额度）' },
  { key: 'ai.review.daily_limit_per_topic', label: '单帖每日 AI 调用上限', value: 3, min: 1, max: 20, hint: '同一个帖子一天最多调几次，防刷（d7 §1 硬规则 3）' },
];

/** POST /api/v1/admin/ai/test（测试连通）的三种回执。真实实现只返回真结果，mock 依次走三种形态。 */
export type AiTestResult =
  | { kind: 'ok'; latency_ms: number; model: string; raw: string }
  | { kind: 'auth'; status: number; message: string }
  | { kind: 'net'; message: string; timeout_ms: number };

export const AI_TEST_SEQUENCE: AiTestResult[] = [
  { kind: 'ok', latency_ms: 842, model: 'deepseek-flash', raw: '{"verdict":"review","reason":"这是一次连通性测试，判为转人工以示返回可解析","categories":["other"]}' },
  { kind: 'auth', status: 401, message: 'authentication_error: Invalid API key provided（Key 可能已撤销或粘贴时带了空格）' },
  { kind: 'net', message: '请求超时：POST https://api.deepseek.com/chat/completions 在 20000ms 内没有响应', timeout_ms: 20000 },
];

/** 一次**试跑**的回执：真的判这段内容，带 verdict / reason / categories（d7 §3.5 的三个字段）。 */
export type AiTrialResult = {
  verdict: AiVerdict;
  reason: string;
  categories: AiCategory[];
  model: string;
  latency_ms: number;
  /** 模型原始回执：Tool Calls 路径下就是 tool_calls[0].function.arguments 那段 JSON 字符串。 */
  raw: string;
};

// 判定规则。**这是 mock**：真实判定完全由模型做。这里只保证「点试跑能看见三种结论」，
// 且理由与 15-admin 帖子审核队列里已有的 review_events 文案对得上（同一份假数据，不自相矛盾）。
// shortcut: 关键词表，只够演示三档；真实实现里模型才是判定方。
const JUDGE_RULES: { re: RegExp; verdict: 'reject' | 'review'; category: AiCategory; reason: string }[] = [
  { re: /优惠券|免费领取|限时活动|加群|扫码|代练|出售账号|私聊|站外|引流|推广|微信|QQ ?群/i,
    verdict: 'reject', category: 'ad', reason: '广告 / 引流：正文含站外推广或交易信息。' },
  { re: /破解|外挂|盗版|未授权|付费素材|激活码/i,
    verdict: 'reject', category: 'illegal', reason: '疑似侵权或违规：未授权素材 / 破解内容。' },
  { re: /垃圾|滚出去|傻子|弱智|你这种人|人身攻击/i,
    verdict: 'reject', category: 'abuse', reason: '辱骂 / 人身攻击。' },
  { re: /网盘|提取码|直链/,
    verdict: 'review', category: 'other', reason: '正文含网盘直链与提取码：来源与授权无法从文本判断，交人工确认。' },
];

/** 判定一段内容。空/噪声一律 review —— d7 §3.5「绝不猜、绝不放行」。 */
export function judgeContent(input: { scenario: AiScenario; title: string; body: string; report_count: number }): Pick<AiTrialResult, 'verdict' | 'reason' | 'categories'> {
  const text = input.title + '\n' + input.body;
  if ([...input.body.trim()].length < 10) {
    return { verdict: 'review', reason: '正文为空或接近噪声，按提示词必须交人工，不要自己决定。', categories: ['other'] };
  }
  for (const r of JUDGE_RULES) {
    if (r.re.test(text)) return { verdict: r.verdict, reason: r.reason, categories: [r.category] };
  }
  if (input.scenario === 'report' && input.report_count >= 3) {
    return {
      verdict: 'review',
      reason: '已被 ' + input.report_count + ' 人举报，但正文里没有可判定的违规特征；涉及来源与授权争议，交人工。',
      categories: ['other'],
    };
  }
  return { verdict: 'approve', reason: '与本站主题一致，没有广告、攻击或违规特征。', categories: [] };
}

/** 试跑出来的完整回执（判定 + 演示用的耗时/模型/原始 JSON）。 */
export function runTrial(input: { scenario: AiScenario; title: string; body: string; report_count: number }): AiTrialResult {
  const v = judgeContent(input);
  return {
    ...v,
    model: AI_CONFIG.model,
    latency_ms: 700 + (input.title.length % 7) * 110,
    raw: JSON.stringify({ verdict: v.verdict, reason: v.reason, categories: v.categories }),
  };
}

/**
 * 审核历史（GET /api/v1/admin/ai/events 的形状；d7 §5.2 review_events 只增不改）。
 * **不是每个帖子的当前状态**，而是一串事件：AI 先说通过、复审再说违规，两条都要留着（申诉时要看的就是它）。
 * 这里直接把 15-admin 已有的 REVIEW_EVENTS 摊平成全站视图，不另造一份假数据。
 */
export type AiHistoryRow = ReviewEvent & { topic_id: string; topic_title: string };

export const AI_HISTORY: AiHistoryRow[] = Object.entries(REVIEW_EVENTS)
  .flatMap(([topicId, events]) => events.map((e) => ({
    ...e,
    topic_id: topicId,
    topic_title: REVIEW_QUEUE.find((t) => t.id === topicId)?.title ?? topicId,
  })))
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

/** 试跑的内容源：直接从待审队列里取（真页面是「选一篇待审帖」，不是让你手打）。 */
export const AI_TRIAL_SOURCES = REVIEW_QUEUE.filter((t) => t.body).map((t) => ({ key: t.id, label: t.title }));

export function trialSource(id: string): { title: string; body: string } {
  const found = REVIEW_QUEUE.find((t) => t.id === id);
  return { title: found?.title ?? '', body: found?.body ?? '' };
}

// 17 · 申诉与反馈 —— **事由配置 + 假数据**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 怎么加一种新事由（这是「可复用」的落点，改这一个数组就够了）
// ══════════════════════════════════════════════════════════════════════════════
// 在 APPEAL_TYPES 里加一条：
//
//   {
//     type: 'xxx',                    // ?type=xxx 的值（小写 + 下划线）
//     label: '下拉里显示的名字',
//     intro: '选它时显示在表单顶上的说明：去哪找单号、要填什么',
//     ref: { label: '单号/链接', placeholder: '...', required: true, help: '去哪抄这个号' },
//     required: ['ref'],              // 哪种问法下必填：'ref' | 'self'
//     paid: true,                     // 被驳回的是付费内容才写（决定用哪个敬称）
//     evidence: { label: '凭证位标题', hint: '要什么材料' },
//     done: { unit: '申诉单号', eta: '多久答复', follow: '答复在哪看', promise: '成功文案' },
//   }
//
// 字段可选值（FORM_FIELDS）：type / actor / ref / email / proof / title / details / contact / captcha / evidence。
// 不要改 JSX 去加分支 —— 表单、必填校验、单号前缀、成功态文案都从这条配置读。
// 「我的申诉」列表的 SERVER_APPEALS 要按 type 加一条对应的假记录，出的图才覆盖得到这一种。
// ══════════════════════════════════════════════════════════════════════════════
//
// 依据：完全重构/盲审合并结论.md §7「被封者的申诉入口」（登录页让人「联系管理员」，
// 但被封者登不进来、也发不了帖）；拍板 §10.10-1 已给帖子申诉定端点
// POST /api/v1/topics/{id}/review/appeal（**登录 + 仅作者**，幂等）。
// 因此本页分两条身份路：已登录（走拍板那个端点，复用登录态）与未登录（本人被挡在门外，
// 只能靠「用户名 + 邮箱 + 图形验证码」自证）—— 后者就是被封的人，也是本页存在的理由。
//
// 本页是设计验证页：数据写死在这里，不 fetch、不接 api client。
// 每个值都必须**是编的**（同 16-auth/data.ts 的教训：这个文件会被构建进公开部署的房间）。

/** 事由 key。加一种事由 = 在 APPEAL_TYPES 里加一条，不是在这里加分支。 */
export type AppealType = 'ban' | 'review_reject' | 'report_result' | 'other';

/** 表单里一个字段的静态说明。JSX 里没有 if(type === ...) 这种东西，全靠这张表。 */
export type FieldSpec = {
  label: string;
  /** 未登录时必填（本人被挡在门外，只能自证身份） */
  guestRequired: boolean;
  /** 已登录时必填（登录态本身就是身份，字段可省就省） */
  selfRequired: boolean;
  placeholder?: string;
  help?: string;
};

export type AppealTypeConfig = {
  type: AppealType;
  label: string;
  /** 选中这一种时显示在表单顶上的说明 */
  intro: string;
  /** 指向「那件事」的字段：封禁案号 / 被驳回的帖子 / 被举报的内容 */
  ref: FieldSpec;
  /** 可选凭证附件的标题与提示（本轮只做位置与提示，不接上传） */
  evidence: { label: string; hint: string };
  /** 被牵涉的内容是付费的才为 true —— 只影响敬称（「您」还是「你」） */
  paid?: boolean;
  /**
   * 只渲染用：这一种事由**必须登录**（后端只认当事人）。
   * 与必填项无关 —— 它决定「未登录时表单换成一屏说明 + 去登录入口」，而不是字段飘红。
   * 封禁申诉**不设**这个标记：被封的人正是登不进来的人。
   */
  selfOnly?: boolean;
  done: {
    /** 成功态里「单号」这一行的标签 */
    unit: string;
    /** 多久内答复 */
    eta: string;
    /** 去哪看进展 */
    follow: string;
    /** 成功文案（说清「我们没有静默吞掉」） */
    promise: string;
  };
  /** 服务端字段名 →「我的申诉」列表里那条假记录 */
  serverRow: string;
};

/** 表单字段的唯一清单（顺序 = 页面上的顺序）。 */
export const FORM_FIELDS = [
  'type',
  'actor',
  'ref',
  'email',
  'proof',
  'title',
  'details',
  'contact',
  'captcha',
  'evidence',
] as const;
export type FieldKey = (typeof FORM_FIELDS)[number];

/** 三种事由的字段差异 —— 这张表就是「可复用」的证明。 */
export const APPEAL_TYPES: AppealTypeConfig[] = [
  {
    type: 'ban',
    label: '账号封禁申诉',
    intro:
      '被封的账号登不进来，所以这一种**不需要登录**：填上被封的用户名 + 注册邮箱 + 图形验证码，我们按这三样核对。',
    ref: {
      label: '封禁案号或封禁时间',
      guestRequired: false,
      selfRequired: false,
      placeholder: '例如 2026-10-12，或私信里的案号',
      help: '不记得就留空：我们按用户名与邮箱查这条封禁记录。',
    },
    evidence: { label: '证明材料（可选）', hint: '截图、录像、原始发布内容——本轮只留位置，还没接上传' },
    done: {
      unit: '申诉单号',
      eta: '3 个工作日内',
      follow: '答复会发到你上面填的邮箱；同样的单号可以在本页「我的申诉」里查状态。',
      promise: '我们已经收到你的申诉，它不会静默消失：无论维持还是解封，都会给你一条答复。',
    },
    serverRow: 'ap-2409',
  },
  {
    type: 'review_reject',
    label: '帖子审核被驳回',
    intro:
      '帖子被判定未通过时的申诉。登录后提交（拍板 §10.10：端点只认作者本人），被驳回的帖子只会被申诉一次。',
    ref: {
      label: '被驳回的帖子链接或标题',
      guestRequired: true,
      selfRequired: true,
      placeholder: '例如 https://…/p/1234，或帖子标题',
      help: '同一篇被驳回的帖子只能申诉一次，重复提交会返回既有状态、不再重复投递。',
    },
    evidence: { label: '证明材料（可选）', hint: '被误判的原文片段、说明为何不违规——本轮只留位置，还没接上传' },
    paid: true,
    selfOnly: true,
    done: {
      unit: '复核单号',
      eta: '1 个工作日内',
      follow: '答复会发到你的注册邮箱；帖子里「未通过审核」的提示更新为「已进入人工复核」。',
      promise: '已进入人工复核队列，审核事件里留了一条记录；复核结果会通知你，不会没有下文。',
    },
    serverRow: 'ap-2407',
  },
  {
    type: 'report_result',
    label: '举报处理结果有异议',
    intro: '你认为自己对某条内容的举报处理得不合适。举报人本人也能提交，不需要是当事人。',
    ref: {
      label: '举报对象（链接或标题）',
      guestRequired: true,
      selfRequired: true,
      placeholder: '你举报的那篇帖子 / 那条回复',
      help: '如果还能找到举报回执里的编号，一并写上更快。',
    },
    evidence: { label: '佐证（可选）', hint: '为什么不认同这个处理结果——本轮只留位置，还没接上传' },
    done: {
      unit: '异议单号',
      eta: '3 个工作日内',
      follow: '答复会发到你的注册邮箱；管理员会在举报队列里重看这条处理记录。',
      promise: '已收到你的异议，会由另一位管理员重看这条处理记录，结果会答复你。',
    },
    serverRow: 'ap-2405',
  },
  {
    type: 'other',
    label: '其它反馈',
    intro: '不属于上面三种的都走这里：功能建议、页面故障、规则疑问、账号安全问题。',
    ref: {
      label: '涉及的地方（可选）',
      guestRequired: false,
      selfRequired: false,
      placeholder: '例如某个页面 / 某条帖子 / 某个功能',
      help: '能给出具体位置最好：附上链接或截图的描述，我们复现得快一些。',
    },
    evidence: { label: '附件位（可选）', hint: '截图、日志、复现步骤——本轮只留位置，还没接上传' },
    done: {
      unit: '反馈单号',
      eta: '5 个工作日内',
      follow: '答复会发到你的注册邮箱；也可以在「我的申诉」里看状态。',
      promise: '反馈已记录。就算我们决定不做，也会告诉你为什么——不会让它烂在队列里。',
    },
    serverRow: 'ap-2403',
  },
];

export const APPEAL_TYPE_LABEL: Record<AppealType, string> = Object.fromEntries(
  APPEAL_TYPES.map((t) => [t.type, t.label]),
) as Record<AppealType, string>;

/** URL 别名：?type=ban 之外，帖子页那边叫 appeal，管理端叫 report，都认 */
export const TYPE_ALIAS: Record<string, AppealType> = {
  appeal: 'review_reject',
  review: 'review_reject',
  report: 'report_result',
  feedback: 'other',
};

export function isAppealType(v: string): v is AppealType {
  return APPEAL_TYPES.some((t) => t.type === v);
}

// ── 身份字段的静态说明（表单按 actor 选 guestRequired 还是 selfRequired） ──
export const FIELD: Record<'actor' | 'email' | 'proof' | 'title' | 'details' | 'contact' | 'captcha', FieldSpec> = {
  actor: {
    label: '用户名或邮箱',
    guestRequired: true,
    selfRequired: false,
    placeholder: '被封 / 出问题的那个账号',
    help: '被封的人登不进来，所以我们按用户名 + 邮箱核对，而不是靠登录态。',
  },
  email: {
    label: '注册邮箱',
    guestRequired: true,
    selfRequired: false,
    placeholder: 'demo@example.com',
    help: '答复发到这里，必须与账号注册邮箱一致；它就是这条申诉的身份凭证。',
  },
  proof: {
    label: '还记得的登录方式',
    guestRequired: false,
    selfRequired: false,
    placeholder: '第三方登录 / 常登录的城市 / 注册大致时间',
    help: '可留空。写上一两条能帮我们确认账号确实是你本人的。',
  },
  title: { label: '标题', guestRequired: true, selfRequired: true, placeholder: '一句话说清这次申诉/反馈' },
  details: { label: '详细说明', guestRequired: true, selfRequired: true },
  contact: {
    label: '其它联系方式（可选）',
    guestRequired: false,
    selfRequired: false,
    placeholder: 'QQ / 微信 / 手机，可留空',
    help: '只在邮箱联系不上你时用，不会公开。',
  },
  captcha: {
    label: '图形验证码',
    guestRequired: true,
    selfRequired: false,
    help: '未登录时必填：这条链路不要求登录，所以要挡住脚本批量申诉。',
  },
};

/** 必填判定的唯一实现：actor=guest 用 guestRequired 那一列，登录后用 selfRequired。 */
export function requiredKeys(cfg: AppealTypeConfig, actor: 'guest' | 'self'): FieldKey[] {
  const col = actor === 'guest' ? 'guestRequired' : 'selfRequired';
  const keys: FieldKey[] = ['actor', 'email'];
  if (cfg.ref[col]) keys.push('ref');
  keys.push('title', 'details');
  if (actor === 'guest') keys.push('captcha');
  return keys;
}

// ── 「我的申诉」列表 ──
export type AppealStatus = 'pending' | 'replied' | 'rejected' | 'closed';

export const STATUS_LABEL: Record<AppealStatus, string> = {
  pending: '待处理',
  replied: '已答复',
  rejected: '已驳回',
  closed: '已关闭',
};

export type AppealRecord = {
  no: string;
  type: AppealType;
  title: string;
  status: AppealStatus;
  submittedAt: string;
  /** 待处理才有：预计答复时间 */
  eta?: string;
  /** 已答复 / 已驳回才有 */
  reply?: string;
  repliedAt?: string;
};

/** 服务端已经有的记录（假的）。本轮提交出来的记录会插到它前面。 */
export const SERVER_APPEALS: AppealRecord[] = [
  {
    no: 'ap-2409',
    type: 'ban',
    title: '账号 demo-admin 被封，申请解封',
    status: 'pending',
    submittedAt: '昨天 21:40',
    eta: '3 个工作日内',
  },
  {
    no: 'ap-2407',
    type: 'review_reject',
    title: '《第三章 撤退战 图文攻略》被判定未通过',
    status: 'replied',
    submittedAt: '10-11 14:02',
    reply: '已恢复展示：AI 把地图编辑器的截图误判成外链。给你补了一张「已复核」标记。',
    repliedAt: '10-12 09:15',
  },
  {
    no: 'ap-2405',
    type: 'report_result',
    title: '对「灌水回复」的处理结果有异议',
    status: 'rejected',
    submittedAt: '10-08 11:20',
    reply: '维持原处理：该回复在三个分区重复发布同一段内容，按版规 4.2 记警告一次。',
    repliedAt: '10-09 16:40',
  },
  {
    no: 'ap-2403',
    type: 'other',
    title: '建议首页增加「仅看战役」筛选',
    status: 'closed',
    submittedAt: '09-30 20:11',
    reply: '已采纳，排进下一轮首页改版。感谢反馈。',
    repliedAt: '10-02 10:05',
  },
];

/** 未登录时能看到的记录：本页自己提交过的（表头会说明这一点，不假装是全量） */
export const GUEST_VISIBLE_NOS = ['ap-2409', 'ap-2403'];

export const MOCK_GUEST = {
  /** 提交成功后的假单号前缀 */
  noPrefix: 'ap-',
  /** 未登录时页面顶上的引导语 */
  guestIntro:
    '不需要登录：被封禁的账号登不进来、也发不了帖，所以这条链路专门给「进不来的人」留了一条路。凭用户名 + 注册邮箱 + 图形验证码提交。',
  selfIntro: '你已登录，身份字段会按账号自动带出、不可修改。',
  loginHref: '?page=16-auth',
  /** 事务码（后端错误码）——只出现在 DevRoom 演示条的提示里 */
  errorNote: '服务端契约：429 appeal.rate_limited（同一账号/IP 24 小时最多 3 条）+ 字段错误走 error.fields。',
};

/** DevRoom 演示：假单号计数器（真实现由后端发号） */
export function nextNo(seq: number): string {
  return MOCK_GUEST.noPrefix + String(2500 + seq);
}

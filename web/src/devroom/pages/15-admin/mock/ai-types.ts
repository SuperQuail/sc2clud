// AI 审核的三个枚举 —— 单独一个文件，因为 mock/content.ts（review_events 假数据）与 mock/ai.ts（配置/提示词/历史）
// 都要用它们，而 ai.ts 本身要 import content.ts。放这里两边都 import 它，**不构成环**，也不复制第二份枚举。

/** d7 §1 / §3.5：三种结论。review = 拿不准，交人工。 */
export type AiVerdict = 'approve' | 'reject' | 'review';

/** d7 §3.2 的 submit_review.parameters.categories 枚举。 */
export type AiCategory = 'spam' | 'ad' | 'abuse' | 'off_topic' | 'illegal' | 'other';

export const AI_VERDICT_LABEL: Record<AiVerdict, string> = {
  approve: '通过', reject: '违规', review: '拿不准 · 转人工',
};

export const AI_CATEGORY_LABEL: Record<AiCategory, string> = {
  spam: '刷屏', ad: '广告 / 引流', abuse: '辱骂 / 攻击', off_topic: '与本站无关', illegal: '违规 / 侵权', other: '其它',
};

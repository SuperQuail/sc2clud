import { describe, expect, it } from 'vitest';
import {
  APPEAL_TYPES,
  APPEAL_TYPE_LABEL,
  FORM_FIELDS,
  GUEST_VISIBLE_NOS,
  SERVER_APPEALS,
  TYPE_ALIAS,
  isAppealType,
  requiredKeys,
  type AppealType,
} from './data';

// 事由配置是数据驱动的 —— 那么「配置写漏了」就只能在运行时报出来（少一个必填项 = 用户能提交空申诉）。
// 这组断言把「一条事由配置必须有什么」写成可执行的形式：加新事由时它自己会告诉你漏了什么。
describe('17-appeal 事由配置', () => {
  it('四种事由齐全，且 key 与 label 一一对应', () => {
    expect(APPEAL_TYPES.map((t) => t.type)).toEqual(['ban', 'review_reject', 'report_result', 'other']);
    for (const t of APPEAL_TYPES) expect(APPEAL_TYPE_LABEL[t.type]).toBe(t.label);
  });

  it('每条配置都写全了：文案 / 必填列 / 成功文案（缺一条 = 页面上少一块）', () => {
    for (const t of APPEAL_TYPES) {
      expect(t.label.length, t.type).toBeGreaterThan(0);
      expect(t.intro.length, t.type).toBeGreaterThan(10);
      expect(t.ref.label.length, t.type).toBeGreaterThan(0);
      // help 在类型上是可选的，但**每条配置都该写**：这里用 ?? '' 兜住类型，行为不变
      //（undefined 时长度 0，断言照样失败 —— 意图是「缺一条就红」）
      expect((t.ref.help ?? '').length, t.type).toBeGreaterThan(0);
      expect(t.evidence.label.length, t.type).toBeGreaterThan(0);
      expect(t.evidence.hint.length, t.type).toBeGreaterThan(0);
      // 成功态的四个字段一个都不能空：单号 / 时效 / 去哪看 / 承诺
      expect(t.done.unit.length, t.type).toBeGreaterThan(0);
      expect(t.done.eta.length, t.type).toBeGreaterThan(0);
      expect(t.done.follow.length, t.type).toBeGreaterThan(0);
      expect(t.done.promise.length, t.type).toBeGreaterThan(10);
    }
  });

  it('必填项都来自 FIELD 清单，且**未登录那条路一定含图形验证码**', () => {
    for (const t of APPEAL_TYPES) {
      const guest = requiredKeys(t, 'guest');
      for (const k of guest) expect(FORM_FIELDS, t.type + '/' + k).toContain(k);
      // 本页存在的理由：被封的人登不进来。少一次验证码校验就是一条可以被脚本刷的匿名提交通道。
      expect(guest, t.type).toContain('captcha');
      expect(guest, t.type).toContain('actor');
      expect(guest, t.type).toContain('email');
      expect(guest, t.type).toContain('details');
      // 已登录时不再要求验证码（身份已经由登录态证明）
      expect(requiredKeys(t, 'self'), t.type).not.toContain('captcha');
    }
  });

  it('URL 别名都指向真实事由（?type= 打错字不该静默变成别的意思）', () => {
    for (const [alias, target] of Object.entries(TYPE_ALIAS)) {
      expect(isAppealType(target), alias).toBe(true);
    }
    expect(isAppealType('ban')).toBe(true);
    expect(isAppealType('nope')).toBe(false);
    expect(TYPE_ALIAS['appeal']).toBe<AppealType>('review_reject');
  });

  it('列表里的假记录对得上事由，且状态与答复字段自洽', () => {
    for (const r of SERVER_APPEALS) {
      expect(APPEAL_TYPES.some((t) => t.type === r.type), r.no).toBe(true);
      // 有答复就一定要有答复时间；「待处理」不许带答复文案（否则列表自己打自己脸）
      if (r.reply) expect(r.repliedAt, r.no).toBeTruthy();
      if (r.status === 'pending') {
        expect(r.reply, r.no).toBeUndefined();
        expect(r.eta, r.no).toBeTruthy();
      }
    }
    // 未登录可见的那几条必须真在表里，否则页面上「我的申诉」是空的
    for (const no of GUEST_VISIBLE_NOS) expect(SERVER_APPEALS.some((r) => r.no === no), no).toBe(true);
    // 单号不许重复：它是查询凭据
    expect(new Set(SERVER_APPEALS.map((r) => r.no)).size).toBe(SERVER_APPEALS.length);
  });
});

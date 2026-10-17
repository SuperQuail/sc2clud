import { describe, expect, it } from 'vitest';
import { AI_BUILTIN_PROMPTS, AI_CONFIG, AI_HISTORY, AI_TRIAL_SOURCES, effectivePrompt, judgeContent, trialSource } from './ai';

// 判定逻辑是这一屏唯一的非平凡逻辑（分支 + 正则 + 兜底），所以留一条会红的检查（开发必读 §5）。
// 断言的是**结论**（verdict / categories / 提示词文本），不是实现细节。

describe('judgeContent', () => {
  it('广告 → reject（ad），且空正文一律 review —— 绝不自动放行', () => {
    const ad = judgeContent({ scenario: 'create', title: '免费领取优惠券', body: '限时活动，加群私聊领取，点击进入站外链接。', report_count: 0 });
    expect(ad.verdict).toBe('reject');
    expect(ad.categories).toEqual(['ad']);

    const empty = judgeContent({ scenario: 'create', title: '第一次发帖', body: '   ', report_count: 0 });
    expect(empty.verdict).toBe('review');
    expect(empty.categories).toEqual(['other']);
  });

  it('网盘直链 → review（来源与授权无法从文本判断），不是直接放行', () => {
    const v = judgeContent({ scenario: 'create', title: '地形纹理包 v3', body: '下载：网盘直链 + 提取码 8k2d，素材来源是网上搜集。', report_count: 0 });
    expect(v.verdict).toBe('review');
  });

  it('举报复核：干净内容被举报到 3 条 → review，理由里带上真实举报数', () => {
    const v = judgeContent({ scenario: 'report', title: '触发器里的动态难度', body: '聊聊三种写法各自的性能代价，欢迎讨论。', report_count: 3 });
    expect(v.verdict).toBe('review');
    expect(v.reason).toContain('3 人举报');
  });

  it('同一条干净内容：新帖首发 → approve（两个场景不是同一档）', () => {
    const v = judgeContent({ scenario: 'create', title: '触发器里的动态难度', body: '聊聊三种写法各自的性能代价，欢迎讨论。', report_count: 3 });
    expect(v.verdict).toBe('approve');
    expect(v.categories).toEqual([]);
  });
});

describe('effectivePrompt', () => {
  it('留空回落内置默认；举报复核那套把 N 换成真实举报数', () => {
    expect(effectivePrompt(AI_CONFIG, 'create')).toBe(AI_BUILTIN_PROMPTS.create);
    expect(effectivePrompt(AI_CONFIG, 'report', 3)).toContain('已被 3 人举报，重点看是否违规');
    expect(effectivePrompt({ ...AI_CONFIG, prompt: '自定义的' }, 'create')).toBe('自定义的');
  });
});

it('审核历史：每条都补上了帖子标题，且按时间倒序（一行 = 一次判定）', () => {
  expect(AI_HISTORY.length).toBeGreaterThan(0);
  expect(AI_HISTORY.every((r) => r.topic_title !== '' && r.topic_title !== r.topic_id)).toBe(true);
  const sorted = [...AI_HISTORY].sort((a, b) => b.created_at.localeCompare(a.created_at));
  expect(AI_HISTORY.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
});

it('试跑内容源都有正文（否则试跑面板会拿到空内容、一律判 review）', () => {
  expect(AI_TRIAL_SOURCES.length).toBeGreaterThanOrEqual(3);
  for (const s of AI_TRIAL_SOURCES) {
    expect([...trialSource(s.key).body].length, s.key).toBeGreaterThan(10);
  }
});

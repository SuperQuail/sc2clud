import { describe, expect, it } from 'vitest';
import { issueSearchLabels, matchesQuery, parseQuery, tokenize } from './query';

// 检索限定词解析的测试（本任务唯一必须带的测试）。
// 数据形状照 IssueSummary + 详情扩展，字段名与后端契约一致。
const ISSUE = {
  id: 128,
  title: '第三章隐藏结局在 15:00 前抵达也不触发',
  body: '按攻略在右上角废墟等事件，已经提前到 14:20 了还是没触发。',
  status: 'open' as const,
  kind: 'bug' as const,
  labels: ['战役', '阻塞'],
  authorNickname: '陆战队员',
  authorHandle: 'demo-marine',
};
const HIT = {
  ...ISSUE,
  authorNickname: ISSUE.authorNickname,
  authorHandle: ISSUE.authorHandle,
  number: 128,
};

describe('tokenize', () => {
  it('引号里的空格不分词', () => {
    expect(tokenize('label:"界面 bug" is:open')).toEqual(['label:界面 bug', 'is:open']);
  });
});

describe('parseQuery', () => {
  it('解析 is / kind / label / author 四类限定词', () => {
    const q = parseQuery('is:open kind:bug label:战役 author:@demo-marine 隐藏结局');
    expect(q.status).toBe('open');
    expect(q.kind).toBe('bug');
    expect(q.labels).toEqual(['战役']);
    expect(q.author).toBe('demo-marine');
    expect(q.text).toBe('隐藏结局');
    expect(q.unknown).toEqual([]);
  });

  it('is:closed 与独立文本可共存，引号值原样保留', () => {
    const q = parseQuery('is:closed label:"已修复" 读档');
    expect(q.status).toBe('closed');
    expect(q.labels).toEqual(['已修复']);
    expect(q.text).toBe('读档');
  });

  it('认不出的 key 留在自由文本里（不吞掉用户输入）', () => {
    const q = parseQuery('sha:abc123 崩溃');
    expect(q.tokens).toEqual([]);
    expect(q.text).toBe('sha:abc123 崩溃');
  });

  it('值不合法的限定词进 unknown，不改变状态与类型', () => {
    const q = parseQuery('is:done kind:foo');
    expect(q.status).toBeUndefined();
    expect(q.kind).toBeUndefined();
    expect(q.unknown.map((t) => t.raw)).toEqual(['is:done', 'kind:foo']);
  });

  it('大小写与冒号位置都不敏感：10:30 不是限定词', () => {
    const q = parseQuery('IS:Open KIND:Bug 10:30');
    expect(q.status).toBe('open');
    expect(q.kind).toBe('bug');
    expect(q.text).toBe('10:30');
  });

  it('空查询不报错', () => {
    const q = parseQuery('');
    expect(q.text).toBe('');
    expect(q.tokens).toEqual([]);
  });
});

describe('matchesQuery', () => {
  it('空查询命中一切', () => {
    expect(matchesQuery(parseQuery(''), HIT)).toBe(true);
  });

  it('按状态、类型、作者（handle 与昵称）命中', () => {
    expect(matchesQuery(parseQuery('is:open'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('is:closed'), HIT)).toBe(false);
    expect(matchesQuery(parseQuery('kind:bug'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('kind:feature'), HIT)).toBe(false);
    expect(matchesQuery(parseQuery('author:demo-marine'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('author:队员'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('author:demo-admin'), HIT)).toBe(false);
  });

  it('标签命中：中文标签、kind 字面量、#编号', () => {
    expect(matchesQuery(parseQuery('label:战役'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('label:bug'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('label:#128'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('label:已修复'), HIT)).toBe(false);
  });

  it('自由文本搜标题、正文与编号', () => {
    expect(matchesQuery(parseQuery('隐藏结局'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('废墟'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('128'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('完全不存在的词'), HIT)).toBe(false);
  });

  it('限定词与自由文本是 AND 关系', () => {
    expect(matchesQuery(parseQuery('is:open 隐藏结局'), HIT)).toBe(true);
    expect(matchesQuery(parseQuery('is:closed 隐藏结局'), HIT)).toBe(false);
  });
});

describe('issueSearchLabels', () => {
  it('标签之外的 kind 字面量也能被 label: 搜到', () => {
    expect(issueSearchLabels(HIT)).toEqual(['战役', '阻塞', 'bug']);
  });
});

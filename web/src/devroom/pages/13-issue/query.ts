import type { IssueKind, IssueStatus } from './types';

// GitHub 式检索限定词的**纯前端解析**（本页是设计验证页，不接 api client）。
// 支持：is:open|closed、kind:bug、label:xxx、author:xxx，带引号的值 "..."，未知 key 留在自由文本里。
// 解析与匹配都是纯函数，放在单独文件里是为了能单测（任务硬要求）。
export const QUALIFIER_KEYS = ['is', 'kind', 'label', 'author'] as const;

/** 能被解析出的限定词（键名小写，值去掉引号） */
export type QueryToken = { key: string; value: string; raw: string };

export type ParsedQuery = {
  /** 自由文本（去掉限定词后剩下的部分） */
  text: string;
  status?: IssueStatus;
  kind?: IssueKind;
  labels: string[];
  author?: string;
  /** 全部限定词（含不认识的），用于在界面上显示「已识别/没识别」 */
  tokens: QueryToken[];
  /** 值不合法的限定词（例如 is:done、kind:foo），界面上要提示 */
  unknown: QueryToken[];
};

/** 把查询串切成词。引号内的空格不分词：label:"界面 bug" */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  for (const ch of input) {
    if (ch === '"') {
      quote = !quote;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseQuery(input: string): ParsedQuery {
  const labels: string[] = [];
  const tokens: QueryToken[] = [];
  const unknown: QueryToken[] = [];
  const free: string[] = [];
  let status: IssueStatus | undefined;
  let kind: IssueKind | undefined;
  let author: string | undefined;

  for (const word of tokenize(input)) {
    const sep = word.indexOf(':');
    const key = sep > 0 ? word.slice(0, sep).toLowerCase() : '';
    if (sep <= 0 || !(QUALIFIER_KEYS as readonly string[]).includes(key)) {
      // 不是限定词：整词进自由文本（'10:30' 这类不会被误当作限定词）
      free.push(word);
      continue;
    }
    // author 以 @ 开头是习惯写法（author:@tangtian），去掉它更好匹配 handle
    const value = key === 'author' ? word.slice(sep + 1).replace(/^@/, '') : word.slice(sep + 1);
    const token: QueryToken = { key, value, raw: word };
    tokens.push(token);
    if (!value) {
      unknown.push(token);
      continue;
    }
    if (key === 'is') {
      if (value.toLowerCase() === 'open' || value.toLowerCase() === 'closed') {
        status = value.toLowerCase() === 'open' ? 'open' : 'closed';
      } else {
        unknown.push(token);
      }
    } else if (key === 'kind') {
      const k = value.toLowerCase();
      if (k === 'bug' || k === 'feature' || k === 'difficulty' || k === 'other') kind = k;
      else unknown.push(token);
    } else if (key === 'label') {
      labels.push(value);
    } else if (key === 'author') {
      author = value.toLowerCase();
    }
  }

  return { text: free.join(' ').trim(), status, kind, labels, author, tokens, unknown };
}

/** 一条 Issue 里可被检索的标签（labels 字段 + 由 kind 派生的中文类型徽标） */
export function issueSearchLabels(issue: { labels?: string[]; kind: IssueKind }): string[] {
  return [...(issue.labels ?? []), issue.kind];
}

/** 检索串是否命中一条数据。空串命中一切。 */
export function matchesQuery(
  query: ParsedQuery,
  issue: { title: string; body: string; status: IssueStatus; kind: IssueKind; labels?: string[]; authorNickname: string; authorHandle: string; number: number },
): boolean {
  if (query.status && query.status !== issue.status) return false;
  if (query.kind && query.kind !== issue.kind) return false;
  if (query.author) {
    const a = query.author;
    if (a !== issue.authorHandle.toLowerCase() && !issue.authorNickname.toLowerCase().includes(a)) return false;
  }
  const haystack = issueSearchLabels(issue).map((l) => l.toLowerCase());
  for (const need of query.labels) {
    const n = need.toLowerCase();
    // 也允许 label:进度 这类中文标签与 #123 编号
    if (!haystack.some((l) => l === n) && n !== '#' + issue.number) return false;
  }
  if (query.text) {
    const t = query.text.toLowerCase();
    const inText = (issue.title + ' ' + issue.body).toLowerCase().includes(t) || ('#' + issue.number).includes(t);
    if (!inText) return false;
  }
  return true;
}

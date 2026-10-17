import { Bug, Gauge, Lightbulb, MoreHorizontal, type LucideIcon } from 'lucide-react';
import type { IssueKind } from './types';

// 四类 Issue 的图标与强调色：**只在这里定义一次**，Issue 入口按钮与列表标签都从这里取。
// 颜色取值全部是 Ring UI 的主题变量（深浅色自动翻转），所以两套主题都看得清，也没有写死色值：
//   bug 红 / feature 蓝 / difficulty 橙 / other 紫。
// 用 Tailwind 的任意属性把颜色挂到 --k 上，再用 text-(--k) / color-mix 取值——
// 这样「哪种 kind 是什么色」只有一处，Tailwind 也扫得到字面量类名（拼字符串它扫不到）。
export const ISSUE_KIND_ICON: Record<IssueKind, LucideIcon> = {
  bug: Bug,
  feature: Lightbulb,
  difficulty: Gauge,
  other: MoreHorizontal,
};

export const ISSUE_KIND_ACCENT: Record<IssueKind, string> = {
  bug: '[--k:var(--ring-icon-error-color)]',
  feature: '[--k:var(--ring-link-color)]',
  difficulty: '[--k:var(--ring-warning-color)]',
  other: '[--k:var(--ring-purple-text-color)]',
};

// 后端的值域是**数据驱动**的（加一类不发前端版），而图标与颜色是前端的设计决定 ——
// 新那一类必然没有登记。回落成「其他」那一套（图标 + 紫色）而不是崩掉/透明：
// 界面上的名字仍然用它自己的（resolveKindName 走端点的 name），只是外观暂缺。
const FALLBACK_KIND = 'other';

export function kindIcon(kind: IssueKind): LucideIcon {
  return ISSUE_KIND_ICON[kind] ?? ISSUE_KIND_ICON[FALLBACK_KIND]!;
}

export function kindAccent(kind: IssueKind): string {
  return ISSUE_KIND_ACCENT[kind] ?? ISSUE_KIND_ACCENT[FALLBACK_KIND]!;
}

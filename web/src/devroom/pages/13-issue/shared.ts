import { TopicTaskTabs } from '../12-topic/_task/task-tabs';
import { IssueKindButton } from '../12-topic/_task/issue-kind-button';
import type { IssueKind } from '../12-topic/_task/types';

// 与帖子内容页（12-topic）**同源**的共享件：顶部两个大按钮 + 四个类型入口按钮。
// 直接 import W1 的 _task 目录，不复制一份；文案（ISSUE_KIND_META）也共用它们那份。
export { TopicTaskTabs, IssueKindButton };
export type { IssueKind };

/** 四个入口的固定顺序：Bug → 功能 → 难度 → 其他 */
export const KINDS: IssueKind[] = ['bug', 'feature', 'difficulty', 'other'];

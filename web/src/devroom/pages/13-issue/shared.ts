import { TopicTaskTabs } from '../12-topic/_task/task-tabs';
import { IssueKindButton } from '../12-topic/_task/issue-kind-button';
import { resolveKindName, type IssueKind } from '../12-topic/_task/types';

// 与帖子内容页（12-topic）**同源**的共享件：顶部两个大按钮 + 四个类型入口按钮。
// 直接 import W1 的 _task 目录，不复制一份；文案（ISSUE_KIND_META）也共用它们那份。
export { TopicTaskTabs, IssueKindButton };
export type { IssueKind };

/** 入口的**兜底**顺序（Bug → 功能 → 难度 → 其他）。
 *
 *  **它不是值域**：值域是 `GET /issues/kinds`（后端 issue_kinds 表 + sort 列决定顺序）。
 *  这份只在「端点还没回来 / 拿不到」时顶上，为的是四个入口在任何一瞬都画得出来 ——
 *  房间（13-issue 的设计验证页，那里不接 api client）也用它。 */
export const FALLBACK_KINDS: IssueKind[] = ['bug', 'feature', 'difficulty', 'other'];

/** 兜底值域的形状（\`{ key, name }\`，与 \`GET /issues/kinds\` 的条目同形）。
 *  构造点只有这一处：房间与产品页共用，免得两份映射各自漂移。 */
export const FALLBACK_KIND_OPTIONS: { key: IssueKind; name: string }[] = FALLBACK_KINDS.map((key) => ({
  key,
  name: resolveKindName(key),
}));

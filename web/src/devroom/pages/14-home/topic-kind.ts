import { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import type { TopicKind } from './mock';

// 类型的文案与配色：**数据文件**（不是组件文件），所以常量与组件可以各自放一处，
// 不会踩 react-refresh 的「一个文件只导出组件」告警。
export const TOPIC_KIND_LABEL: Record<TopicKind, string> = {
  discussion: '讨论',
  resource: '资源',
  repost: '转载',
};

// 类型徽标：Ring Tag 的预设色自带半透明底（registry.ts 的 tag 条目已登记），不写死色值
export const KIND_TAG: Record<TopicKind, TagType> = {
  discussion: TagType.MAIN,
  resource: TagType.SUCCESS,
  repost: TagType.PURPLE,
};

// 无封面时的色块：全站只有一个可安全当「色」的令牌 --primary，靠浓度区分三种类型
export const KIND_TINT: Record<TopicKind, string> = {
  discussion: 'from-primary/15',
  resource: 'from-primary/8',
  repost: 'from-primary/5',
};

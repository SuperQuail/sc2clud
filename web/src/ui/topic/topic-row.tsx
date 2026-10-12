import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { appPath } from '@/lib/url';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';

// 主题列表的一行（全站最常用的排布）。**数据驱动**：作者、标签、统计都由调用方给，
// 组件不认识「分区」「个人主页」这些业务——所以分区页、搜索页、个人主页可以共用同一行。
// 之前样板间里那份是页面内的局部件（改一处要改两处），这里抽出来作为唯一实现。
export type TopicRowData = {
  id: number | string;
  title: string;
  tags?: Array<{ text: string; type?: TagType }>;
  author: {
    nickname: string;
    avatar?: string | null;
    role?: { key: string; name: string } | null;
    title?: { name: string; color?: string | null } | null;
  };
  replies?: number;
  views?: number;
  /** 最后回复时间（已格式化） */
  lastReplyAt?: string;
};

export function TopicRow({ topic }: { topic: TopicRowData }) {
  return (
    <article className='flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40'>
      <UserAvatar name={topic.author.nickname} src={topic.author.avatar} size='sm' />
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <span className='flex flex-wrap items-center gap-2'>
          {topic.tags?.map((t) => (
            <Tag key={t.text} tagType={t.type ?? TagType.DEFAULT}>
              {t.text}
            </Tag>
          ))}
          <a
            href={appPath('t/' + topic.id)}
            className='min-w-0 truncate rounded-[3px] text-[15px] font-medium text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            {topic.title}
          </a>
        </span>
        <span className='flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
          <Username nickname={topic.author.nickname} size='sm' />
          {topic.author.role ? <RoleBadge role={topic.author.role} /> : null}
          {topic.author.title ? <TitleBadge title={topic.author.title} size='sm' /> : null}
          {typeof topic.replies === 'number' || typeof topic.views === 'number' ? (
            <span className='tabular-nums'>
              · {topic.replies ?? 0} 回复 · {topic.views ?? 0} 浏览
            </span>
          ) : null}
          {topic.lastReplyAt ? <span className='ml-auto tabular-nums'>{topic.lastReplyAt}</span> : null}
        </span>
      </div>
    </article>
  );
}

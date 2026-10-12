import { Fragment } from 'react';
import { appPath } from '@/lib/url';

// 评论正文渲染。**@提及的底层存的是用户 id**，显示时渲染成昵称，点击跳用户主页。
// 存储格式（与后端约定）：`@{123|唐天}` —— 123 是 users.id，唐天是当时的昵称。
// 只存 id 不存昵称是不行的（要显示）；只存昵称也不行（昵称可改、且可重名）——两个都存，显示用后者。
const MENTION = /@\{(\d+)\|([^}]+)\}/g;

export function CommentBody({ body, className }: { body: string; className?: string }) {
  const parts: Array<string | { id: string; nickname: string }> = [];
  let last = 0;
  for (const m of body.matchAll(MENTION)) {
    if (m.index! > last) parts.push(body.slice(last, m.index));
    parts.push({ id: m[1]!, nickname: m[2]! });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));

  return (
    <p className={className}>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <a
            key={i}
            href={appPath('u/' + p.id)}
            className='rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            @{p.nickname}
          </a>
        ),
      )}
    </p>
  );
}

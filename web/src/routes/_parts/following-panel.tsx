import { qk } from '@/lib/query/keys';
import { fetchMyFollowedBoards, fetchMyFollowedUsers } from '@/lib/api/follow';
import { BoardFollowList, UserFollowList } from './follow-lists';

// 「我关注的」：两档列表（GET /me/following/boards 与 GET /me/following/users）。
//
// 落点理由（在两处候选里挑了设置页）：这两条是 /me/* 的**账号私域** —— 谁关注了谁只对本人有意义，
// 而个人主页 /u/{handle} 是**任何人都能看的公开页**，把自读的列表挂上去要多一条 isSelf 支路，
// 且它的真源（/me/*）与那一页的数据流（/users/{handle}）不是同一族；
// 接线门禁给 /me/* 的建议落地屏也写的是 settings.tsx。设置页本身就是「我的账号」汇总屏（设备 / 提醒 / 赞赏）。
export function FollowingPanel() {
  return (
    <section
      data-testid='following-panel'
      className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'
    >
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>我关注的</h2>
      <h3 className='m-0 text-[13px] font-medium text-muted-foreground'>分区</h3>
      <BoardFollowList
        queryKey={qk.followingBoards()}
        fetchPage={(signal) => fetchMyFollowedBoards({}, signal)}
        emptyTitle='还没有关注分区'
        emptyHint='在分区页点页头那颗「关注分区」，它会出现在这里。'
      />
      <h3 className='m-0 text-[13px] font-medium text-muted-foreground'>用户</h3>
      <UserFollowList
        queryKey={qk.followingUsers()}
        fetchPage={(signal) => fetchMyFollowedUsers({}, signal)}
        emptyTitle='还没有关注用户'
        emptyHint='在别人的主页点「关注」，TA 会出现在这里。'
      />
    </section>
  );
}

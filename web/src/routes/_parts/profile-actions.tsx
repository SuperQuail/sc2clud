import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, MessageSquare, UserPlus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { fetchUserFollow, followUser, unfollowUser } from '@/lib/api/follow';
import { BlockAction } from './block-action';

// 别人主页的动作条：关注 / 私信 / 举报 / 拉黑。从 profile.tsx 抽出来的一格 ——
// 抽它的理由只有一条：profile.tsx 已经 474 行，贴着 gate:size 的 500，而这一格是它里面最大的一块版式。
//
// 三条口径照旧，一条都不改：
//   · 关注态**以服务端回执为准**（回执写回缓存，不本地翻转；关注/取关都是幂等的）；
//   · 未登录不发这个请求（后端也拒），那一档画的是去登录的链接 —— 不是一颗点了没反应的按钮；
//   · 「举报」面板本身在页面根部（_parts/report-panel 是就地展开的一块版面），这里只负责开与合：
//     把版面塞进 hero 的动作槽会把页头撑坏。
export function ProfileActions({ handle, isLoggedIn, reporting, onToggleReport }: {
  handle: string;
  isLoggedIn: boolean;
  reporting: boolean;
  onToggleReport: () => void;
}) {
  const qc = useQueryClient();
  const follow = useQuery({
    queryKey: qk.followUser(handle),
    queryFn: ({ signal }) => fetchUserFollow(handle, signal),
    enabled: handle !== '' && isLoggedIn,
  });
  const followToggle = useMutation({
    mutationFn: (next: boolean) => (next ? followUser(handle) : unfollowUser(handle)),
    onSuccess: (st) => qc.setQueryData(qk.followUser(handle), st),
  });

  return (
    <>
      {isLoggedIn ? (
        <Button
          data-testid='profile-follow'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(UserPlus)}
          primary={!follow.data?.following}
          active={follow.data?.following}
          loader={followToggle.isPending}
          onClick={() => followToggle.mutate(!(follow.data?.following ?? false))}
        >
          {follow.data?.following ? '已关注' : '关注'}
        </Button>
      ) : (
        <Button
          data-testid='profile-follow'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(UserPlus)}
          href={appPath('login?next=' + encodeURIComponent(routePath('u/' + handle)))}
        >
          登录后关注
        </Button>
      )}
      <Button
        inline={false}
        height={ControlsHeight.S}
        icon={icon16(MessageSquare)}
        href={appPath('messages/' + encodeURIComponent(handle))}
      >
        发私信
      </Button>
      {isLoggedIn ? (
        <Button
          data-testid='profile-report'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Flag)}
          active={reporting}
          onClick={onToggleReport}
        >
          举报
        </Button>
      ) : null}
      {isLoggedIn ? <BlockAction handle={handle} /> : null}
    </>
  );
}

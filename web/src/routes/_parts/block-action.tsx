import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useMutation } from '@tanstack/react-query';
import { Ban } from 'lucide-react';
import { ConfirmDialog } from '@/devroom/pages/15-admin/confirm';
import { icon16 } from '@/ui/icons';
import { apiErrorLine, isApiError } from '@/lib/api/errors';
import { blockUser, unblockUser } from '@/lib/api/user';

// 拉黑 / 解除拉黑（PUT/DELETE /users/{handle}/block，真源 forum/internal/forum/votes.go:190）。
// 它改的是**关系**，所以落在主页动作条（关注 / 私信 / 举报 那一排），不是哪一屏的独立按钮。
// 「拉黑」先走确认弹层（后果要写清）；「解除拉黑」不问第二遍 —— 它只是把限制撤掉。
//
// shortcut: 后端**没有读拉黑状态的端点**（只有这一对动作），所以按钮的态只能来自动作回执：
//           刷新之后它会回到「拉黑」那一档。升级时机：后端补 GET /users/{handle}/block 的那一天。
export function BlockAction({ handle }: { handle: string }) {
  const [blocked, setBlocked] = useState(false);
  const [asking, setAsking] = useState(false);
  const block = useMutation({
    mutationFn: () => blockUser(handle),
    onSuccess: () => {
      setBlocked(true);
      setAsking(false);
    },
  });
  const unblock = useMutation({ mutationFn: () => unblockUser(handle), onSuccess: () => setBlocked(false) });
  const pending = block.isPending || unblock.isPending;
  const error = block.error ?? unblock.error;

  return (
    <>
      <Button
        data-testid='profile-block'
        inline={false}
        height={ControlsHeight.S}
        danger={!blocked}
        active={blocked}
        icon={icon16(Ban)}
        loader={pending}
        disabled={pending}
        onClick={() => (blocked ? unblock.mutate() : setAsking(true))}
      >
        {blocked ? '解除拉黑' : '拉黑'}
      </Button>
      {error ? (
        <span role='alert' className='text-[12px] text-destructive'>
          {isApiError(error) ? apiErrorLine(error) : '操作失败，请重试'}
        </span>
      ) : null}
      <ConfirmDialog
        show={asking}
        label={'拉黑 @' + handle + '？'}
        confirmText='拉黑'
        danger
        body={
          <span>
            拉黑后 TA 不能再回复你的内容，你也不会收到 TA 的回复提醒；TA 仍然看得到你的帖子。随时可以解除。
          </span>
        }
        onClose={() => setAsking(false)}
        onConfirm={() => block.mutate()}
      />
    </>
  );
}

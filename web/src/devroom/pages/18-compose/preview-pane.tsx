import { X } from 'lucide-react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { icon16 } from '@/ui/icons';
import { PreviewCard } from './submit-gate';
import type { Draft } from './draft';

// 预览：把 draft.html 渲染出来的样子。渲染走 **@/ui/comment/comment-body → @/ui/markdown**，
// 也就是帖子页正文用的同一个件（全站唯一渲染 content_html 的地方），所以预览与发布后**不可能不一致**。
// 收起是纯 CSS 的 hidden，预览树不卸载 —— 否则每次展开都要重新渲染一遍图片。
export function PreviewPane({ draft, show = true, onHide }: { draft: Draft; show?: boolean; onHide?: () => void }) {
  return (
    <section aria-label='预览' className={'flex flex-col gap-2 ' + (show ? '' : 'hidden')}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='m-0 text-[13px] font-semibold text-foreground'>预览</h2>
        {onHide ? (
          <Button inline={false} height={ControlsHeight.S} icon={icon16(X)} onClick={onHide} aria-label='收起预览'>
            收起
          </Button>
        ) : null}
      </div>
      <PreviewCard draft={draft} />
    </section>
  );
}

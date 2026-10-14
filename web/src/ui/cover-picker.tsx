import { useEffect, useRef, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { imagePath } from '@/lib/url';

// 「换一张封面」的**共用弹层**（个人主页 / 设置页与后台分区屏三处都用它）。
//
// 为什么收成一个件：用户报的「设置背景功能消失」根因不是控件坏了，而是**每个地方各自决定画不画**——
// 收成 ① 控件（image-uploader 的 cover 形态）② 这个弹层 ③ 各页只给一个「传上去了」的回调，
// 入口的形状就只有一处会变。
//
// 用原生 <dialog> + showModal()：焦点陷阱、ESC、backdrop 都是浏览器给的，不自己写一套。
export type CoverPickerHandle = { open: () => void };

export type CoverPickerProps = {
  /** 当前封面（/img/<hash> 或本地预览 URL）；用于弹层里的预览位 */
  cover?: string | null;
  /** 选中一张之后干什么（各处分别发 POST /me/cover 或 /me/cover + PATCH 分区） */
  onPick: (file: Blob) => void;
  /** 弹层底部的动作（「清空封面」/「关闭」由调用方给：三处的清空语义不同） */
  actions?: ReactNode;
  pending?: boolean;
  /** 挂载后回传句柄：页面别处的按钮可以代它打开（与 AvatarSetting 的 onReady 同一用法） */
  onReady?: (api: CoverPickerHandle | null) => void;
  label?: string;
};

export function CoverPicker({ cover, onPick, actions, pending = false, onReady, label = '更换封面' }: CoverPickerProps) {
  const [open, setOpen] = useState(false);
  // 弹层内容**第一次打开才挂载**：<dialog> 里的东西即使没打开也躺在 DOM 里，
  // 于是页面会凭空多出一个 input[type=file]（DevRoom 那条「别人主页连上传控件都不在 DOM 里」
  // 的用例就是靠数它来判的 —— 多一个就说明入口漏出来了，实测红过）。
  const [everOpened, setEverOpened] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  // 命令式开合：<dialog> 的 showModal/close 才是真正的开关（写 open 属性不会进模态层）。
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    onReady?.({ open: () => { setEverOpened(true); setOpen(true); } });
    return () => onReady?.(null);
  }, [onReady]);

  return (
    <>
      <Button inline={false} height={ControlsHeight.S} disabled={pending} onClick={() => { setEverOpened(true); setOpen(true); }}>
        {label}
      </Button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        aria-label='设置封面'
        className='w-[min(560px,92vw)] rounded-xl border border-border bg-card p-4 text-foreground backdrop:bg-foreground/40'
      >
        <h2 className='m-0 mb-3 text-[15px] font-semibold text-foreground'>封面 / 背景</h2>
        {everOpened ? (
        <ImageUploader
          variant='cover'
          label='上传封面'
          compress
          images={cover ? [{ id: 'cover', name: 'cover.webp', size: 0, url: imagePath(cover), original: false, file: new Blob() }] : []}
          onChange={(list: UploadedImage[]) => {
            const f = list[0];
            if (f) onPick(f.file);
          }}
        />
        ) : null}
        <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
          横幅图最好看（16:9 或更宽）；长边压到 1600，服务端硬上限 2MB。选完即上传。
        </p>
        <div className='mt-3 flex flex-wrap items-center justify-end gap-2'>
          {actions}
          <Button inline={false} height={ControlsHeight.S} onClick={() => setOpen(false)}>关闭</Button>
        </div>
      </dialog>
    </>
  );
}

// 设计稿里本来不做动作的按钮，点了必须**有话说**，不许静默（缺陷处理总纲 §7）。
// 这一份是**全站统一的说法**，别的房间/别的 agent 也照这句抄——Lead 最后统一收口时只改这一个字面量。
// 形式：一行 role=status 的文案（不做 toast、不做弹层），插在被点的那一行下面。
export const DESIGN_ACTION_NOTE = '设计稿：这个按钮还没接线，点了不会有别的动作。';

export function DesignActionNote({ message }: { message?: string }) {
  return (
    <p
      role='status'
      data-testid='design-action-note'
      className='w-fit rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'
    >
      {message ?? DESIGN_ACTION_NOTE}
    </p>
  );
}

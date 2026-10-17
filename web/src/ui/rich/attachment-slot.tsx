import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { FileArchive, FileText, Film, Map, Paperclip, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 附件位（发帖页用）。与 ImageUploader 同一个套路：**点选与拖拽共用一份校验**，
// 文件选择的原生 input[type=file] 只能写在这里（src/ui 是唯一允许封装控件的地方，见开发必读 §1）。
//
// ⚠️ **本轮只做「位置与提示」**：附件到底存哪、多大、与 release_assets 什么关系还没拍板
// （盲审合并结论 §6.2），所以这里不接上传，只把「有没有选、选的什么、会不会被拒」摆在页面上。
// 真接线时只换 onChange 的去处（本地 File → POST /api/v1/uploads），这个件不用改。
export type Attachment = {
  id: string;
  name: string;
  size: number;
  file: File;
};

/** 附件类型：图标与说明由扩展名定，不由 MIME 定（.SC2Map 在浏览器里没有可靠的 MIME） */
function kindOf(name: string): { Icon: typeof Map; label: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'sc2map' || ext === 'sc2mapmod') return { Icon: Map, label: '地图' };
  if (ext === 'sc2replay' || ext === 'rep') return { Icon: Film, label: '录像' };
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return { Icon: FileArchive, label: '压缩包' };
  return { Icon: FileText, label: '文本' };
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

export function AttachmentSlot({
  files,
  onChange,
  accept,
  max = 5,
  maxSizeMb = 20,
  label = '添加附件',
  hint,
  disabled = false,
}: {
  files: Attachment[];
  onChange: (next: Attachment[]) => void;
  /** 允许的扩展名，写法与 input 的 accept 一致（.SC2Map,.zip,…） */
  accept: string;
  max?: number;
  maxSizeMb?: number;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const exts = accept.split(',').map((e) => e.trim().toLowerCase());

  function accept_(picked: File[]) {
    const room = Math.max(0, max - files.length);
    const okExt = picked.filter((f) => exts.some((e) => f.name.toLowerCase().endsWith(e)));
    const okSize = okExt.filter((f) => f.size <= maxSizeMb * 1024 * 1024);
    const kept = okSize.slice(0, room);
    // 拒绝的三种原因分开说：只报一种的话，用户会以为换一张就过了
    const why = [
      okExt.length < picked.length ? '只收 ' + accept + ' 这几种' : null,
      okSize.length < okExt.length ? '单个不能超过 ' + maxSizeMb + 'MB' : null,
      kept.length < okSize.length ? '最多 ' + max + ' 个' : null,
    ].filter(Boolean);
    setError(why.length > 0 ? '已忽略 ' + (picked.length - kept.length) + ' 个文件：' + why.join('；') : null);
    if (kept.length > 0) onChange([...files, ...kept.map((f) => ({ id: Math.random().toString(36).slice(2), name: f.name, size: f.size, file: f }))]);
    if (input.current) input.current.value = '';
  }

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        accept_(Array.from(e.dataTransfer.files));
      }}
      className={'flex flex-col gap-2 rounded-lg border border-dashed p-3 ' + (dragging ? 'border-primary bg-primary/8' : 'border-border')}
    >
      <input
        ref={input}
        type='file'
        accept={accept}
        multiple
        className='hidden'
        onChange={(e) => accept_(Array.from(e.target.files ?? []))}
      />
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Paperclip)}
          disabled={disabled || files.length >= max}
          onClick={() => input.current?.click()}
        >
          {label + '（' + files.length + ' / ' + max + '）'}
        </Button>
        <span className='text-[11px] text-muted-foreground'>{hint ?? '把文件拖到这里也可以；附件位本轮不接上传。'}</span>
      </div>
      {error ? (
        <span role='alert' className='text-[12px] text-destructive'>
          {error}
        </span>
      ) : null}
      {files.length > 0 ? (
        <ul className='m-0 flex list-none flex-col gap-1 p-0'>
          {files.map((f) => {
            const { Icon, label: kind } = kindOf(f.name);
            return (
              <li key={f.id} className='flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1'>
                <Icon aria-hidden className='size-3.5 shrink-0 text-muted-foreground' />
                <span className='min-w-0 flex-1 truncate text-[12px] text-foreground'>{f.name}</span>
                <span className='shrink-0 text-[11px] text-muted-foreground'>
                  {kind} · {sizeLabel(f.size)}
                </span>
                <Button
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(X)}
                  aria-label={'移除 ' + f.name}
                  disabled={disabled}
                  onClick={() => onChange(files.filter((x) => x.id !== f.id))}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

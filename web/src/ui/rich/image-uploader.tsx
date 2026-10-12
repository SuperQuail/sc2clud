import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ImagePlus, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { COMPRESS_LABEL, IMAGE_ACCEPT, planImages, processImage } from './image-pipeline';

// 图片上传控件（可复用）。**点选与拖拽共用同一条管线**（image-pipeline），所以限额与压缩只有一份规则。
// 两种形态：
//   list   —— 多图（默认上限 10）：按钮 + 原图开关 + 缩略图网格。发帖配图用。
//   avatar —— 单图（强制 1 张）：圆形预览 + 更换/移除。**换头像、封面这类单图位用它**。
// 文件选择用隐藏的原生 input[type=file]（浏览器只允许这样选文件），触发按钮是 Ring Button。
export type UploadedImage = {
  id: string;
  name: string;
  size: number;
  /** 预览用 object URL，或上传后服务端返回的 /img/<hash> */
  url: string;
  /** 是否为原图（未压缩） */
  original: boolean;
  file: Blob;
};

export function ImageUploader({
  images,
  onChange,
  variant = 'list',
  max = 10,
  compress = true,
  allowOriginal = false,
  label = '添加图片',
  showThumbnails = true,
  onError,
}: {
  images: UploadedImage[];
  onChange: (next: UploadedImage[]) => void;
  variant?: 'list' | 'avatar';
  max?: number;
  compress?: boolean;
  allowOriginal?: boolean;
  label?: string;
  /** list 形态是否显示缩略图网格（编辑器里图片已是正文内容，传 false） */
  showThumbnails?: boolean;
  /** 限额丢弃等提示交给使用方（表单要显示错误行） */
  onError?: (message: string) => void;
}) {
  const limit = variant === 'avatar' ? 1 : max;
  const input = useRef<HTMLInputElement>(null);
  const [useOriginal, setUseOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { room } = planImages(0, { existing: images.length, max: limit });

  async function accept(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    const opts = { existing: images.length, max: limit, compress, useOriginal };
    const { room: free, dropped: over } = planImages(list.length, opts);
    const msg = over > 0 ? '最多 ' + limit + ' 张，已忽略多出的 ' + over + ' 张' : null;
    setError(msg);
    onError?.(msg ?? '');
    if (free === 0) return;
    setBusy(true);
    const out: UploadedImage[] = [];
    for (const f of list.slice(0, free)) {
      const blob = await processImage(f, opts);
      out.push({
        id: Math.random().toString(36).slice(2),
        name: f.name,
        size: blob.size,
        url: URL.createObjectURL(blob),
        original: compress === false || useOriginal,
        file: blob,
      });
    }
    setBusy(false);
    onChange([...images, ...out]);
    if (input.current) input.current.value = '';
  }

  const fileInput = (
    <input
      ref={input}
      type='file'
      accept={IMAGE_ACCEPT}
      multiple={variant === 'list'}
      className='hidden'
      onChange={(e) => void accept(e.target.files)}
    />
  );

  if (variant === 'avatar') {
    const current = images[0];
    return (
      <div className='flex items-center gap-4'>
        {fileInput}
        {current ? (
          <img
            src={current.url}
            alt='已选头像'
            width={72}
            height={72}
            className='size-18 rounded-full border border-border object-cover'
          />
        ) : (
          <UserAvatar name='未设置' size='xl' />
        )}
        <div className='flex flex-col gap-1.5'>
          <div className='flex items-center gap-2'>
            <Button icon={icon16(ImagePlus)} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? '处理中…' : current ? '更换' : label}
            </Button>
            {current ? <Button onClick={() => onChange([])}>移除</Button> : null}
          </div>
          <span className='text-[11px] text-muted-foreground'>
            建议正方形；{compress ? '自动压缩' : '保留原图'}，上限 1 张
          </span>
          {error ? <span className='text-[12px] text-destructive'>{error}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-2'>
      {fileInput}
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          icon={icon16(ImagePlus)}
          disabled={room === 0 || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? '处理中…' : label + '（' + (room > 0 ? '还能 ' + room + ' 张' : '已满') + '）'}
        </Button>
        {compress && allowOriginal ? (
          <Toggle checked={useOriginal} onChange={(e) => setUseOriginal(e.target.checked)}>上传原图</Toggle>
        ) : null}
        <span className='text-[11px] tabular-nums text-muted-foreground'>
          {images.length} / {limit}{compress && !useOriginal ? '　' + COMPRESS_LABEL : ''}
        </span>
      </div>
      {error ? <span className='text-[12px] text-destructive'>{error}</span> : null}
      {showThumbnails && images.length > 0 ? (
        <ul className='flex flex-wrap gap-2'>
          {images.map((im) => (
            <li key={im.id} className='relative'>
              <img
                src={im.url}
                alt={im.name}
                width={88}
                height={88}
                className='size-22 rounded-md border border-border object-cover'
              />
              <span className='absolute left-1 top-1 rounded-[3px] bg-foreground/70 px-1 text-[10px] text-background'>
                {im.original ? '原图' : '压缩'} {Math.round(im.size / 1024)}KB
              </span>
              <span className='absolute -right-2 -top-2'>
                <Button icon={icon16(X)} aria-label={'移除 ' + im.name} onClick={() => onChange(images.filter((x) => x.id !== im.id))} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

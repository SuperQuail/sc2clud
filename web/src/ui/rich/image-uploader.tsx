import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ImagePlus, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 图片上传控件（可复用）。三件事都做成属性，谁用谁定：
//   max            最多几张（默认 10）
//   compress       是否自动压缩（默认 true，长边 1600、WebP 0.82）
//   allowOriginal  是否允许「上传原图」——**上传端不放开时界面不出现这个开关**
// 文件选择用隐藏的原生 <input type=file>：这是它唯一无法被替代的地方（按钮只做触发）。
export type UploadedImage = {
  id: string;
  name: string;
  size: number;
  /** 预览用的 object URL 或上传后返回的 /img/<hash> */
  url: string;
  original: boolean;
  file: Blob;
};

const MAX_EDGE = 1600;
const QUALITY = 0.82;

async function compressToWebp(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', QUALITY));
  bitmap.close();
  return blob ?? file;
}

export function ImageUploader({
  images,
  onChange,
  max = 10,
  compress = true,
  allowOriginal = false,
  showList = true,
}: {
  images: UploadedImage[];
  onChange: (next: UploadedImage[]) => void;
  max?: number;
  compress?: boolean;
  allowOriginal?: boolean;
  /** 编辑器里用 false：图片已经是正文内容，不必再列一遍缩略图 */
  showList?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [useOriginal, setUseOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, max - images.length);

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const room = Math.max(0, max - images.length);
    const picked = Array.from(files).slice(0, room);
    if (files.length > room) setError('最多 ' + max + ' 张，已忽略多出的 ' + (files.length - room) + ' 张');
    setBusy(true);
    const out: UploadedImage[] = [];
    for (const f of picked) {
      const blob = compress && !useOriginal ? await compressToWebp(f) : f;
      out.push({
        id: Math.random().toString(36).slice(2),
        name: f.name,
        size: blob.size,
        url: URL.createObjectURL(blob),
        original: !compress || useOriginal,
        file: blob,
      });
    }
    setBusy(false);
    onChange([...images, ...out]);
    if (input.current) input.current.value = '';
  }

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          ref={input}
          type='file'
          accept='image/png,image/jpeg,image/gif,image/webp'
          multiple
          className='hidden'
          onChange={(e) => void add(e.target.files)}
        />
        <Button
          icon={icon16(ImagePlus)}
          disabled={left === 0 || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? '处理中…' : '添加图片' + (left ? '（还能 ' + left + ' 张）' : '（已满）')}
        </Button>
        {compress && allowOriginal ? (
          <Toggle checked={useOriginal} onChange={(e) => setUseOriginal(e.target.checked)}>
            上传原图
          </Toggle>
        ) : null}
        <span className='text-[11px] text-muted-foreground tabular-nums'>
          {images.length} / {max}
          {compress && !useOriginal ? '　已自动压缩（长边 ' + MAX_EDGE + '，WebP）' : ''}
        </span>
      </div>
      {error ? <span className='text-[12px] text-destructive'>{error}</span> : null}
      {showList && images.length > 0 ? (
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
                <Button
                  icon={icon16(X)}
                  aria-label={'移除 ' + im.name}
                  onClick={() => onChange(images.filter((x) => x.id !== im.id))}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

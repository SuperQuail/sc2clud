import { useEffect, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ImagePlus, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { ImageCropper } from './image-cropper';
import { imagePath } from '@/lib/url';
import { AVATAR_EDGE, AVATAR_MAX_BYTES, AVATAR_TARGET, COMPRESS_LABEL, formatBytes, IMAGE_ACCEPT, planImages, POST_IMAGE_MAX_BYTES, processImage } from './image-pipeline';

// 图片上传控件（可复用）。**点选与拖拽共用同一条管线**（image-pipeline），所以限额与压缩只有一份规则。
// 两种形态：
//   list   —— 多图（默认上限 10）：按钮 + 原图开关 + 缩略图网格。发帖配图用。
//   avatar —— 单图（强制 1 张）：圆形预览 + 更换/移除。
//   cover  —— 单图（强制 1 张）：16:9 预览 + 更换/移除。个人主页封面 / 分区封面用它
//             （拍板 08 第二轮「壁纸替换」：这两处都必须是真能换、真能清的动作）。
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
  existingCount,
  onError,
  maxSize,
  targetBytes,
  onReady,
  headless = false,
  crop = false,
  cropEdge,
  cropAspect,
  cropAspectOptions,
}: {
  images: UploadedImage[];
  onChange: (next: UploadedImage[]) => void;
  variant?: 'list' | 'avatar' | 'cover';
  max?: number;
  /**
   * **这一步收到的原图**的体积上限（「这张还救不救得动」的边界，见 image-pipeline 的两个常量）。
   * 它**不是**成品目标：成品目标走 targetBytes（或 avatar 形态自带的 AVATAR_TARGET）。
   * 曾经把两者混成一个数，于是「1.3MB 的收款码」被当场拒掉 —— 它本来压得进上限。
   */
  maxSize?: number;
  /** 压缩后的成品目标字节；不传按形态取（avatar 走 AVATAR_TARGET，其余不设目标） */
  targetBytes?: number;
  compress?: boolean;
  allowOriginal?: boolean;
  label?: string;
  /** list 形态是否显示缩略图网格（编辑器里图片已是正文内容，传 false） */
  showThumbnails?: boolean;
  /** 已用掉的名额。**编辑器里图片是正文节点，余额要按正文算**（默认取 images.length） */
  existingCount?: number;
  /** 限额丢弃等提示交给使用方（表单要显示错误行） */
  onError?: (message: string) => void;
  /** 挂载后回传「打开文件选择」的句柄：页面别处的按钮可以代点（例：hero 上的头像就是入口） */
  onReady?: (api: { open: () => void } | null) => void;
  /**
   * 只要那个 file input、**不画自己的界面**（2026-10-14 加）。
   * 用途：本人主页的头像自己就是入口（AvatarPicker），上传器挂在页根只为提供 input 与句柄 ——
   * 与 cover-picker 的 headless 同一用法。限额/错误仍走 onError。
   */
  headless?: boolean;
  /**
   * 单图（avatar）形态：选完之后先弹**裁剪框**选启用区域（D23），确认了才算选中 ——
   * 用户要求「选图后能选区域」。非 avatar 形态（配图/封面）不做：那些是按原比例展示的矩形。
   */
  crop?: boolean;
  /** 裁剪输出的长边上限（默认 512）；成品目标仍由 targetBytes / 形态决定 */
  cropEdge?: number;
  /** D59 裁剪框的默认比例（宽/高；头像 1、横幅封面 21/9）。仅 crop 时有意义 */
  cropAspect?: number;
  /** D59 框上的比例预设（切完即时生效）。仅 crop 且给了它时出现选择器 */
  cropAspectOptions?: { label: string; value: number }[];
}) {
  // 头像与封面都是「一个槽」：已有的那张是「现在这张」，再选一张是换掉它。
  const single = variant !== 'list';
  const limit = single ? 1 : max;
  const sizeLimit = maxSize ?? (variant === 'avatar' ? AVATAR_MAX_BYTES : POST_IMAGE_MAX_BYTES);
  const input = useRef<HTMLInputElement>(null);
  const [useOriginal, setUseOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  // 选了但还没裁的那一张。**必须留在这里**：裁剪框是这一步的结果，裁完才 onChange。
  const [cropping, setCropping] = useState<{ url: string; file: File } | null>(null);
  // **提示只有宿主那一份**（onError）。控件自己再画一行的话，宿主照约定画出来就是**同一句话出现两次**
  // —— D1 就是这么被用户看见的。控件内部因此不留 error state。

  // 头像位只有**一个槽**：已有的那张是「现在这张」，再选一张是**换掉它**，不是「名额已满」。
  // （旧写法 used=images.length 会让头像位 free=0，换头像点了没反应 —— 房间里没人上传所以没暴露。）
  const used = existingCount ?? (single ? 0 : images.length);
  const { room } = planImages({ existing: used, max: limit });

  // 句柄只在挂载期有效（input 是同一个 DOM 节点）；卸载时收回，避免页面拿着已失效的引用去点
  useEffect(() => {
    onReady?.({ open: () => input.current?.click() });
    return () => onReady?.(null);
  }, [onReady]);

  async function accept(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    // 提示一次只给一句，**体积优先**（过大是硬错，张数只是没位置了）
    const opts = { existing: used, max: limit, compress, useOriginal, maxBytes: sizeLimit, files: list };
    const { room: free, dropped: over, tooBig } = planImages(opts);
    // 张数文案**不能盖掉体积文案**：12MB 的图塞进「只收 1 张」的头像位曾经报「最多 1 张，已忽略多出的 1 张」（盲审二号）
    const msg =
      tooBig !== null
        ? '「' + tooBig.name + '」' + formatBytes(tooBig.size) + '，单个文件不能超过 ' + formatBytes(sizeLimit) + '，这一张没有加进来'
        : over > 0
          ? '最多 ' + limit + ' 张，已忽略多出的 ' + over + ' 张'
          : null;
    onError?.(msg ?? '');
    // 过大的先剔掉，再按余额截断：否则一张超大图会把名额占掉，后面正常的图反而进不来
    const usable = list.filter((f) => f.size <= sizeLimit);
    if (free === 0 || usable.length === 0) return;
    // 裁剪通道：不进管线（还没到压的时候），先把选中的原图交给裁剪框。
    const first = usable[0];
    if (crop && single && first) {
      setCropping({ url: URL.createObjectURL(first), file: first });
      if (input.current) input.current.value = '';
      return;
    }
    setBusy(true);
    const out: UploadedImage[] = [];
    for (const f of usable.slice(0, free)) {
      // 封面用默认长边（1600）：它是横幅，压到头像那一档就糊了；服务端上限 2MiB 够装
      const blob = await processImage(f, {
        ...opts,
        maxEdge: variant === 'avatar' ? AVATAR_EDGE : undefined,
        targetBytes: targetBytes ?? (variant === 'avatar' ? AVATAR_TARGET : undefined),
      });
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
    onChange(single ? out.slice(0, 1) : [...images, ...out]);
    if (input.current) input.current.value = '';
  }

  /** 裁完这一块：交给管线做成品压缩（与直接选图**同一条路**），再当作「选中了」报给宿主。 */
  async function confirmCrop(blob: Blob) {
    if (!cropping) return;
    const name = cropping.file.name;
    const url = cropping.url;
    setBusy(true);
    try {
      const out = await processImage(new File([blob], name, { type: blob.type }), {
        existing: 0,
        max: 1,
        compress,
        useOriginal,
        maxBytes: sizeLimit,
        maxEdge: variant === 'avatar' ? AVATAR_EDGE : undefined,
        targetBytes: targetBytes ?? (variant === 'avatar' ? AVATAR_TARGET : undefined),
      });
      onChange([{ id: Math.random().toString(36).slice(2), name, size: out.size, url: URL.createObjectURL(out), original: compress === false || useOriginal, file: out }]);
    } catch {
      onError?.('裁剪后没能生成图片，换一张试试');
    } finally {
      URL.revokeObjectURL(url);
      setBusy(false);
      setCropping(null);
    }
  }

  const fileInput = (
    <input
      ref={input}
      type='file'
      accept={IMAGE_ACCEPT}
      multiple={!single}
      className='hidden'
      onChange={(e) => void accept(e.target.files)}
    />
  );

  const cropper = cropping ? (
    <ImageCropper
      source={cropping.file}
      aspect={cropAspect}
      aspectOptions={cropAspectOptions}
      maxEdge={cropEdge}
      onCropped={(b) => void confirmCrop(b)}
      onCancel={() => {
        URL.revokeObjectURL(cropping.url);
        setCropping(null);
      }}
    />
  ) : null;

  // headless：只交回 input（句柄已经由上面的 useEffect 给出去），不渲染预览与按钮。
  // **但裁剪框照旧渲染** —— 本人主页那颗头像用的就是 headless 形态（挂载点在页根）。
  if (headless) {
    return (
      <>
        {fileInput}
        {cropper}
      </>
    );
  }

  if (single) {
    const current = images[0];
    const cover = variant === 'cover';
    return (
      <div className='flex items-center gap-4'>
        {fileInput}
        {cropper}
        {current ? (
          <img
            src={imagePath(current.url)}
            alt={cover ? '已选封面' : '已选头像'}
            width={cover ? 160 : 72}
            height={cover ? 90 : 72}
            className={
              cover
                ? 'h-22 w-40 shrink-0 rounded-md border border-border object-cover'
                : 'size-18 rounded-full border border-border object-cover'
            }
          />
        ) : cover ? (
          <span className='flex h-22 w-40 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground'>
            <ImagePlus size={16} aria-hidden />
          </span>
        ) : (
          <UserAvatar name='未设置' size='xl' />
        )}
        <div className='flex flex-col gap-1.5'>
          <div className='flex items-center gap-2'>
            {/* icon + 文字时 Ring 会默认走 inline（isInline = inline ?? text ?? !!icon）：
                那会变成 padding:0 的蓝字链接、height 档位失效。显式 inline={false} + S 档，
                点击区才是「一颗按钮」的大小（实测 24px 高、带 padding）。 */}
            <Button
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(ImagePlus)}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? '处理中…' : current ? '更换' : label}
            </Button>
            {/* 「移除」也要 inline={false}：Ring 的 isInline = inline ?? text ?? !!icon —— **只有文字**同样走 inline，
                于是它和左边的「更换」一颗有内边距、一颗没有，两个动作看着不是一套控件。 */}
            {current ? (
              <Button inline={false} height={ControlsHeight.S} onClick={() => onChange([])}>
                移除
              </Button>
            ) : null}
          </div>
          <span className='text-[11px] text-muted-foreground'>
            {cover ? '建议横幅（16:9 或更宽）' : '建议正方形'}；{compress ? '自动压缩' : '保留原图'}，上限 1 张、{'≤' + formatBytes(sizeLimit)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-2'>
      {fileInput}
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(ImagePlus)}
          disabled={room === 0 || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? '处理中…' : label + '（' + (room > 0 ? '还能 ' + room + ' 张' : '已满') + '）'}
        </Button>
        {compress && allowOriginal ? (
          <Toggle checked={useOriginal} onChange={(e) => setUseOriginal(e.target.checked)}>上传原图</Toggle>
        ) : null}
        <span data-testid='image-counter' className='text-[11px] tabular-nums text-muted-foreground'>
          {used} / {limit}{compress && !useOriginal ? '　' + COMPRESS_LABEL : ''}
        </span>
      </div>
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
              {/* 角上的移除：原来是 16×16 的 inline（热区只有图标那么大）。
                  改 24×24 后如果仍用 -right-2 -top-2 会往容器外多探出去，所以定位收进缩略图内部
                  （right-1 top-1 = 距角 4px），实测：不超出 88×88 的 li，也不进相邻缩略图的 8px 间隙。 */}
              <span className='absolute top-1 right-1'>
                <Button
                  inline={false}
                  height={ControlsHeight.S}
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

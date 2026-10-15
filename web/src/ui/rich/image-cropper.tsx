import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Cropper, { type Area, type Point } from 'react-easy-crop';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 选图后的裁剪框（D23 头像；D59 封面/壁纸）。
//
// **裁切引擎换成了 react-easy-crop**：拖动/双指/滚轮/键盘的交互都由它管（这原本是本组件自维护的
// 最大一块正确性面——平移夹取、缩放夹取、裁切矩形到原图坐标的换算），本次把这三个数学 +
// 渲染层一起交给久经考验的库，换掉 image-crop.ts 的整套纯函数（文件随 commit 删除）。
// 留在本组件里的只有三件：读图（Blob/URL → <img>）、比例选择 UI、确认时按**库给的
// croppedAreaPixels（原图坐标）**出成品 blob（canvas 一次 drawImage，长边到 maxEdge 为止）。
//
// 交互：框内拖动定位置；两档按钮缩放 1x–4x（库自带滑杆也同步）；cover 链路可切比例预设。
export type ImageCropperProps = {
  /** 刚选的原始文件（objectURL 也行）：弹层里显示它、裁剪时也从它出成品 */
  source: Blob | string;
  /** 裁剪区的rosis（宽/高）。默认 1（头像）；封面/壁纸给 21/9、16/9 这类横幅比例 */
  aspect?: number;
  /** 裁剪区画圆形（头像是圆的）。默认跟随 aspect===1 */
  round?: boolean;
  /** 框上可切换的比例预设（cover 链路给）。不给就没有选择器 */
  aspectOptions?: { label: string; value: number }[];
  /** 输出长边上限（默认 512）；具体取多大由所选区域的原图分辨率决定 */
  maxEdge?: number;
  onCropped: (blob: Blob) => void;
  onCancel: () => void;
  pending?: boolean;
};

const DEFAULT_MAX_EDGE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export function ImageCropper({ source, aspect = 1, round = aspect === 1, aspectOptions, maxEdge, onCropped, onCancel, pending = false }: ImageCropperProps) {
  const [url, setUrl] = useState('');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // 拖动位置是受控的（库按这个 prop 画）：不存就会拖完弹回去
  const [cropPos, setCropPos] = useState<Point>({ x: 0, y: 0 });
  const [ratio, setRatio] = useState(aspect);
  // 库在 onCropComplete 里给的**原图坐标**裁切矩形；确认时从它出字节
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof source === 'string') {
      setUrl(source);
      return;
    }
    const u = URL.createObjectURL(source);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [source]);

  // 给 Cropper 一张**已加载**的图：裁切几何全由库算，这里只负责把原图读出来交给它。
  useEffect(() => {
    if (!url) return;
    let dead = false;
    (async () => {
      try {
        const el = new Image();
        await new Promise<void>((res, rej) => {
          el.onload = () => res();
          el.onerror = () => rej(new Error('图片没能加载'));
          el.src = url;
        });
        if (!dead) setImg(el);
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : '这张图读不出来');
      }
    })();
    return () => { dead = true; };
  }, [url]);

  async function confirm() {
    if (!area || !img) return;
    setBusy(true);
    try {
      // croppedAreaPixels 是原图坐标的矩形：一次 drawImage 出成品，长边压到 maxEdge 为止
      const longEdge = Math.max(area.width, area.height);
      const scale = Math.min(1, (maxEdge ?? DEFAULT_MAX_EDGE) / longEdge);
      const outW = Math.max(1, Math.round(area.width * scale));
      const outH = Math.max(1, Math.round(area.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器画不出这一块（canvas 不可用）');
      ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, outW, outH);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.92));
      if (!blob) throw new Error('裁剪没能编码成图片');
      onCropped(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : '裁剪没能完成');
    } finally {
      setBusy(false);
    }
  }

  const ready = img !== null && area !== null;
  // D69：通过 portal 渲染 —— 封面链路里这颗 Ring Dialog 曾是「封面/背景」native <dialog> 的
  // **子孙**，native modal 的后代进不了 top layer 的正确层级，命中测试整块被外层 dialog 抢走
  // （白覆盖、拖不动）。portal 到 body 之后两颗 dialog 是兄弟，与头像链路（页面根部挂载）同构。
  return createPortal(
    <Dialog
      show
      modal
      trapFocus
      label='裁剪图片'
      showCloseButton
      onCloseAttempt={onCancel}
      onOverlayClick={onCancel}
      onEscPress={onCancel}
      contentClassName='w-full max-w-[420px] p-5'
    >
      <div className='flex flex-col gap-3'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>裁剪图片</h2>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          框内就是会用到的部分：拖动选位置，缩放定大小{aspectOptions && aspectOptions.length > 0 ? '，比例在框上切' : ''}。
          {round ? '头像显示成圆形，四角会被切掉一点。' : ''}
        </p>

        <div className='flex flex-col items-center gap-2'>
          <div
            data-testid='crop-frame'
            className={round ? 'relative size-[min(300px,78vw)] overflow-hidden rounded-full border border-border bg-muted/40'
              : 'relative w-[min(300px,78vw)] overflow-hidden rounded-md border border-border bg-muted/40'}
            style={round ? undefined : { aspectRatio: String(ratio) }}
          >
            {url ? (
              <Cropper
                image={url}
                crop={cropPos}
                zoom={zoom}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                onZoomChange={setZoom}
                aspect={ratio}
                cropShape={round ? 'round' : 'rect'}
                objectFit='contain'
                showGrid
                onCropChange={setCropPos}
                onCropComplete={(_pct, px) => setArea(px)}
                mediaProps={{ alt: '待裁剪的图', draggable: false }}
              />
            ) : (
              <span className='absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground'>
                {error ?? '正在读图…'}
              </span>
            )}
          </div>
          {aspectOptions && aspectOptions.length > 0 ? (
            <Select
              type={SelectType.INPUT}
              label='裁切比例'
              data={aspectOptions.map((o) => ({ key: String(o.value), label: o.label }))}
              selected={aspectOptions.map((o) => ({ key: String(o.value), label: o.label })).find((o) => o.key === String(ratio)) ?? null}
              onSelect={(item) => { if (item) setRatio(Number(item.key)); }}
            />
          ) : null}
        </div>

        <span className='flex flex-wrap items-center justify-center gap-2'>
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(ZoomOut)}
            data-testid='crop-zoom-out'
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((v) => Math.max(MIN_ZOOM, v - 0.25))}
          >
            缩小
          </Button>
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(ZoomIn)}
            data-testid='crop-zoom-in'
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((v) => Math.min(MAX_ZOOM, v + 0.25))}
          >
            放大
          </Button>
          <span className='text-[11px] tabular-nums text-muted-foreground'>{Math.round(zoom * 100)}%</span>
        </span>

        {error && url ? (
          <p role='alert' className='m-0 text-[12px] text-destructive'>
            {error}
          </p>
        ) : null}

        <div className='flex flex-wrap items-center justify-end gap-2'>
          <Button
            inline={false}
            height={ControlsHeight.S}
            disabled={zoom <= MIN_ZOOM && cropPos.x === 0 && cropPos.y === 0}
            onClick={() => {
              setZoom(1);
              setCropPos({ x: 0, y: 0 });
            }}
          >
            复位
          </Button>
          <Button inline={false} height={ControlsHeight.S} onClick={onCancel}>
            取消
          </Button>
          <Button
            primary
            inline={false}
            height={ControlsHeight.S}
            data-testid='crop-confirm'
            loader={busy || pending}
            disabled={!ready || busy || pending}
            onClick={() => void confirm()}
          >
            就用这一块
          </Button>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}

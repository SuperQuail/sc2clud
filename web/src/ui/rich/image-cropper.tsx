import { useEffect, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { clampPan, clampZoom, cropEdge, cropRect, fitFrame, MAX_ZOOM, MIN_ZOOM, renderCrop } from './image-crop';

// D23（用户 2026-10-15）：头像**选图之后弹裁剪框**选启用区域。
//
// 为什么必须有：头像在页面上是圆的，非正方形/主体偏一边的图会被 CSS 裁掉四边，
// 用户看到的是「我传的是这张，怎么显示成那样」——选区域这件事只能在这一刻做，
// 存下去之后就再也改不了（服务端只存成品）。
//
// 复用房子件：弹层用 Ring 的 Dialog（遮罩/Esc/焦点陷阱都是它的），压缩与成品目标仍走
// image-crop.ts 的 renderCrop → image-uploader 的 image-pipeline（**没有新依赖**）。
//
// 交互只有两件：拖动（平移）+ 两档缩放。**不写滑杆**：Ring 没有 slider，
// 自己画一个 range 就走不到登记表那一条路，而「放大/缩小」两颗按钮已经把这件事说完了。
export type ImageCropperProps = {
  /** 刚选的原始文件（objectURL 也行）：弹层里显示它、裁剪时也从它画 */
  source: Blob | string;
  /** 方框的边长（px）。头像是圆的，内接正方形就是可视区域，所以框是方的。 */
  frame?: number;
  /** 输出长边上限；具体取多大由「所选区域的原图分辨率」决定（cropEdge） */
  maxEdge?: number;
  onCropped: (blob: Blob) => void;
  onCancel: () => void;
  pending?: boolean;
};

const DEFAULT_FRAME = 300;

export function ImageCropper({ source, frame = DEFAULT_FRAME, maxEdge, onCropped, onCancel, pending = false }: ImageCropperProps) {
  const [size, setSize] = useState(frame);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 1) 拿到可画的东西：Blob 走 createImageBitmap（要拿自然尺寸），字符串直接当 src。
  //    两者最终都变成「能 drawImage 的源」—— canvas 对 <img> 与 ImageBitmap 是同一套语义。
  const [drawable, setDrawable] = useState<ImageBitmap | HTMLImageElement | null>(null);
  useEffect(() => {
    let dead = false;
    let made: ImageBitmap | null = null;
    (async () => {
      try {
        if (typeof source === 'string') {
          const el = new Image();
          await new Promise<void>((res, rej) => {
            el.onload = () => res();
            el.onerror = () => rej(new Error('图片没能加载'));
            el.src = source;
          });
          if (dead) return;
          setNatural({ w: el.naturalWidth, h: el.naturalHeight });
          setDrawable(el);
          setUrl(source);
        } else {
          made = await createImageBitmap(source);
          if (dead) return;
          setNatural({ w: made.width, h: made.height });
          setDrawable(made);
          setUrl(URL.createObjectURL(source));
        }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : '这张图读不出来');
      }
    })();
    return () => {
      dead = true;
      made?.close();
    };
  }, [source]);

  // 2) 方框的**实际**边长：它是 CSS 给的（窄屏会比 frame 小），量一次再算几何。
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setSize(w);
  }, []);

  const geom = natural ? fitFrame({ frame: size, naturalW: natural.w, naturalH: natural.h }) : null;
  const p = geom ? clampPan(geom, pan.x, pan.y) : pan;
  const z = clampZoom(zoom);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    drag.current = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !geom) return;
    setPan(clampPan(geom, d.px + (e.clientX - d.x), d.py + (e.clientY - d.y)));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  async function confirm() {
    if (!natural || !drawable) return;
    setBusy(true);
    try {
      const rect = cropRect({ frame: size, naturalW: natural.w, naturalH: natural.h }, z, p);
      const blob = await renderCrop(drawable, rect, cropEdge(rect, maxEdge));
      onCropped(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : '裁剪没能完成');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show
      modal
      trapFocus
      label='裁剪头像'
      showCloseButton
      onCloseAttempt={onCancel}
      onOverlayClick={onCancel}
      onEscPress={onCancel}
      contentClassName='w-full max-w-[420px] p-5'
    >
      <div className='flex flex-col gap-3'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>裁剪头像</h2>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          拖动图片选位置，用「放大 / 缩小」定大小。框内就是头像里能看到的那一块（头像显示成圆形，
          所以四角会被切掉一点）。
        </p>

        <div className='flex justify-center'>
          {/* 方框：overflow-hidden + 一张按 base*zoom 放大、按 pan 平移的图。
              拖动是原生的 pointer 事件（鼠标与触摸同一套），所以手机上也能拖。 */}
          <div
            ref={box}
            data-testid='crop-frame'
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className='relative size-[min(300px,78vw)] shrink-0 cursor-grab touch-none overflow-hidden rounded-full border border-border bg-muted/40'
          >
            {natural && geom && url ? (
              <img
                src={url}
                alt='待裁剪的图'
                draggable={false}
                className='absolute top-1/2 left-1/2 max-w-none select-none'
                style={{
                  width: natural.w * geom.base * z,
                  height: natural.h * geom.base * z,
                  transform: 'translate(-50%, -50%) translate(' + p.x + 'px, ' + p.y + 'px)',
                }}
              />
            ) : (
              <span className='absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground'>
                {error ?? '正在读图…'}
              </span>
            )}
          </div>
        </div>

        <span className='flex flex-wrap items-center justify-center gap-2'>
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(ZoomOut)}
            data-testid='crop-zoom-out'
            disabled={z <= MIN_ZOOM}
            onClick={() => setZoom((v) => clampZoom(v - 0.25))}
          >
            缩小
          </Button>
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(ZoomIn)}
            data-testid='crop-zoom-in'
            disabled={z >= MAX_ZOOM}
            onClick={() => setZoom((v) => clampZoom(v + 0.25))}
          >
            放大
          </Button>
          <span className='text-[11px] tabular-nums text-muted-foreground'>{Math.round(z * 100)}%</span>
        </span>

        {error && natural ? (
          <p role='alert' className='m-0 text-[12px] text-destructive'>
            {error}
          </p>
        ) : null}

        <div className='flex flex-wrap items-center justify-end gap-2'>
          <Button
            inline={false}
            height={ControlsHeight.S}
            disabled={z === MIN_ZOOM && p.x === 0 && p.y === 0}
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
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
            disabled={!natural || busy || pending}
            onClick={() => void confirm()}
          >
            就用这一块
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

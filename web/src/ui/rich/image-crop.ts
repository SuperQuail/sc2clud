// 头像裁剪的**几何**（纯函数，可单测）。
//
// 为什么单独一个文件：交互（拖拽 / 缩放）在 image-cropper.tsx 里，但「取的是哪一块图」
// 与「画到多大」是纯算术 —— 把它与 DOM 混在一起就只剩「出图看着对」这一种验证手段，
// 而裁剪错位（取到边框外、或取了半张脸）在图里未必看得出来。

/** 画框（方形）+ 原图尺寸 —— 解出的「基准铺满」比例与初始偏移。 */
export type CropFrame = { frame: number; naturalW: number; naturalH: number };
export type CropFit = {
  /** 基准比例（cover：缩到刚好铺满方框，不可能是 1 或更小） */
  base: number;
  /** 不会露出空白的最大平移量（基准比例下） */
  maxX: number;
  maxY: number;
};

/**
 * 我把方框框成正方形：头像是圆的，圆的**内接正方形**就是它的可视区域 ——
 * 存一张非正方形的图给圆形头像，四边都会被裁掉，用户看到的是「选的和显示的不一样」。
 */
export function fitFrame({ frame, naturalW, naturalH }: CropFrame): CropFit {
  const base = Math.max(frame / naturalW, frame / naturalH);
  return { base, maxX: (naturalW * base - frame) / 2, maxY: (naturalH * base - frame) / 2 };
}

/**
 * 把平移量夹在「图不露出空白」的范围内。越界的拖动不该把图拖出框。
 *
 * `+ 0` 是把 -0 归一成 0：夹到 0 的轴会算出 -0（Math.max(-0, -0)），
 * 而 -0 在 `toEqual({y: 0})` 下不相等 —— 坐标里没有负零这回事，别让它漏出去。
 */
export function clampPan(f: CropFit, x: number, y: number): { x: number; y: number } {
  return { x: Math.min(f.maxX, Math.max(-f.maxX, x)) + 0, y: Math.min(f.maxY, Math.max(-f.maxY, y)) + 0 };
}

/** 基准比例下、没有拖动时，图是居中的。 */
export function centerPan(f: CropFit): { x: number; y: number } {
  return clampPan(f, 0, 0);
}

/** 缩放档：1 = 铺满，4 = 放到最大。越界一律夹住（滑杆/按钮都不该把它推出去）。 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * 真正要交给 canvas 的那一块：**原图坐标系**里的正方形（正方形才是头像的可见区域）。
 *
 * 页面上图被画成 (naturalW*base*zoom) 宽，平移 (x,y)（也是同一个显示坐标系），
 * 所以取反比例就能换算回原图像素；最后夹一次边界，保证取的区域**一定在图片内**。
 */
export function cropRect(
  { frame, naturalW, naturalH }: CropFrame,
  zoom: number,
  pan: { x: number; y: number },
): { sx: number; sy: number; size: number } {
  const f = fitFrame({ frame, naturalW, naturalH });
  const z = clampZoom(zoom);
  const p = clampPan(f, pan.x, pan.y);
  const scale = f.base * z;
  const size = Math.min(frame / scale, naturalW, naturalH);
  const cx = naturalW / 2 - p.x / scale;
  const cy = naturalH / 2 - p.y / scale;
  const sx = Math.min(Math.max(cx - size / 2, 0), naturalW - size);
  const sy = Math.min(Math.max(cy - size / 2, 0), naturalH - size);
  return { sx, sy, size };
}

/**
 * 输出边长：**取原图那块区域的分辨率**，但夹在 64（再小就没意义）与 maxEdge（默认 512）之间。
 * 512 而不是 256：裁出来还要过一遍 image-pipeline（它自己会压到 64KB 以内），
 * 这里先咬掉一半分辨率的话，用户看不到自己选的那块细节了。
 */
export function cropEdge(rect: { size: number }, maxEdge = 512): number {
  return Math.max(64, Math.min(maxEdge, Math.floor(rect.size)));
}

/** 把原图的一块画进 canvas（方形输出、cover 语义）。canvas 的创建放在这里，交互那边只调它。 */
export async function renderCrop(source: CanvasImageSource, rect: { sx: number; sy: number; size: number }, edge: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  canvas.getContext('2d')!.drawImage(source, rect.sx, rect.sy, rect.size, rect.size, 0, 0, edge, edge);
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/webp', 0.9));
}

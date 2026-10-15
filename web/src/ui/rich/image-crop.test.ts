import { expect, it } from 'vitest';
import { clampPan, clampZoom, cropEdge, cropRect, fitFrame, MAX_ZOOM, MIN_ZOOM } from './image-crop';

// D23（用户 2026-10-15）：头像选图后要有**裁剪框**选启用区域。
//
// 裁剪的算术在这里钉住（交互在 image-cropper.tsx，出图另验）：
// 取的那一块必须**方**、必须**在图片内**、拖到边就不能再拖 —— 这三条错了，
// 用户看到的就是「选的和存的不一样」（而截图里未必看得出来）。

// 1000×500 的横图铺进 300 的方框：按高铺满 → 比例 0.6，宽出 300，左右各能推 150
const WIDE = { frame: 300, naturalW: 1000, naturalH: 500 };

it('cover 铺满：横图按高铺满，左右各留出可推的余量', () => {
  const f = fitFrame(WIDE);
  expect(f.base).toBeCloseTo(0.6, 6);
  expect(f.maxX).toBeCloseTo(150, 6);
  expect(f.maxY).toBeCloseTo(0, 6);
});

it('拖到边就不动：越界的平移被夹回图片内', () => {
  const f = fitFrame(WIDE);
  expect(clampPan(f, 9999, 9999)).toEqual({ x: 150, y: 0 });
  expect(clampPan(f, -9999, -9999)).toEqual({ x: -150, y: 0 });
});

// 关键：取的区域**永远是正方形且在图片内** —— 这是「存下来的和看到的一样」的机器证明。
it('无论怎么拖/怎么缩放，取的区域都是图片内的正方形', () => {
  for (const zoom of [MIN_ZOOM, 1.5, 2.7, MAX_ZOOM, 99]) {
    for (const p of [
      { x: 0, y: 0 },
      { x: 9999, y: 9999 },
      { x: -9999, y: -9999 },
      { x: 73, y: -12 },
    ]) {
      const r = cropRect(WIDE, zoom, p);
      expect(r.size).toBeGreaterThan(0);
      expect(r.sx).toBeGreaterThanOrEqual(0);
      expect(r.sy).toBeGreaterThanOrEqual(0);
      expect(r.sx + r.size).toBeLessThanOrEqual(WIDE.naturalW);
      expect(r.sy + r.size).toBeLessThanOrEqual(WIDE.naturalH);
    }
  }
});

it('放大之后取的是一块更小的区域（缩放真的进到裁切里，不只是视觉）', () => {
  const at1 = cropRect(WIDE, 1, { x: 0, y: 0 });
  const at2 = cropRect(WIDE, 2, { x: 0, y: 0 });
  expect(at2.size).toBeLessThan(at1.size);
  expect(at2.size).toBeCloseTo(at1.size / 2, 6);
});

it('缩放档夹在 1–4；输出边长夹在 64–maxEdge', () => {
  expect(clampZoom(0.2)).toBe(MIN_ZOOM);
  expect(clampZoom(99)).toBe(MAX_ZOOM);
  expect(cropEdge({ size: 1000 })).toBe(512);
  expect(cropEdge({ size: 10 })).toBe(64);
  expect(cropEdge({ size: 400 }, 256)).toBe(256);
});

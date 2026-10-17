import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ImageCropper } from './image-cropper';

// D23（头像裁切）与 D59（封面/壁纸裁切）的钉子。裁切引擎换成 react-easy-crop 之后，
// 真正属于我们的契约只剩两条：
//   确认时把库给的 croppedAreaPixels（**原图坐标**的矩形）画进 canvas；
//   成品 blob 交给 onCropped（后面仍走 image-pipeline 与上传端点，两条路无分叉）。
// jsdom 不解码图片：img 的 src 一被设置（setter）就自动派 load；
// naturalWidth/Height 用 proto getter 钉成原图尺寸；容器大小用 getBoundingClientRect 钉 300。
const NATURAL = { width: 1000, height: 500 };
let drawn: number[] = [];

const saved = {
  srcDesc: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'),
  gBCR: Element.prototype.getBoundingClientRect,
  ctx: HTMLCanvasElement.prototype.getContext,
  toBlob: HTMLCanvasElement.prototype.toBlob,
};

function stubDecode() {
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => NATURAL.width });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => NATURAL.height });
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement, v: string) {
      this.setAttribute('src', v); // setAttribute 直接落实现属性，不会再走这个 setter
      queueMicrotask(() => this.dispatchEvent(new Event('load')));
    },
    get(this: HTMLImageElement) {
      return this.getAttribute('src');
    },
  });
}

function stubCanvas() {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: (_src: unknown, ...rest: number[]) => { drawn = rest; },
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob([new Uint8Array(128)], { type: 'image/webp' }));
  } as unknown as typeof HTMLCanvasElement.prototype.toBlob;
}

function stubFrame(width = 300) {
  const rect = { width, height: width, left: 0, top: 0, right: width, bottom: width, x: 0, y: 0, toJSON: () => ({}) };
  Element.prototype.getBoundingClientRect = (function rectPiece(this: HTMLElement) {
    return rect as unknown as DOMRect;
  }) as unknown as typeof Element.prototype.getBoundingClientRect;
}

afterEach(() => {
  if (saved.srcDesc) Object.defineProperty(HTMLImageElement.prototype, 'src', saved.srcDesc);
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalWidth;
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalHeight;
  Element.prototype.getBoundingClientRect = saved.gBCR;
  HTMLCanvasElement.prototype.getContext = saved.ctx;
  HTMLCanvasElement.prototype.toBlob = saved.toBlob;
  drawn = [];
});

/** 选中的原图：一个 blob（真站从 <input type=file> 来） */
const file = () => new File([new Uint8Array(1024)], 'shot.png', { type: 'image/png' });

async function renderCropper(over: { aspect?: number; aspectOptions?: { label: string; value: number }[]; maxEdge?: number } = {}) {
  stubDecode();
  stubCanvas();
  stubFrame();
  const out: Array<{ size: number; type: string }> = [];
  render(
    <ImageCropper
      source={file()}
      aspect={over.aspect}
      aspectOptions={over.aspectOptions}
      maxEdge={over.maxEdge}
      onCropped={(b) => out.push({ size: b.size, type: b.type })}
      onCancel={() => {}}
    />,
  );
  await waitFor(() => expect((screen.getByTestId('crop-confirm') as HTMLButtonElement).disabled).toBe(false));
  return out;
}

it('确认时把原图坐标的裁切矩形画进 canvas，成品 blob 交给 onCropped', async () => {
  const out = await renderCropper();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  expect(out[0]!.type).toBe('image/webp');
  expect(out[0]!.size).toBeGreaterThan(0);
});

// 核心：默认方形（头像）取的那一块必须是方、而且在原图内（1000×500 的横图 → 最多 500）
it('方形默认：区域是原图内的正方形（横图按高取满）', async () => {
  const out = await renderCropper();
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
  const [sx, sy, sw, sh] = drawn;
  expect(sw).toBeCloseTo(sh!, 6);
  expect(sw).toBeLessThanOrEqual(NATURAL.height);
  expect(sx).toBeGreaterThanOrEqual(0);
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(sx! + sw!).toBeLessThanOrEqual(NATURAL.width);
  expect(sy! + sh!).toBeLessThanOrEqual(NATURAL.height);
});

it('放大真的进到裁切里：放大之后取的源区域更小', async () => {
  const out = await renderCropper();
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  const first = drawn[2];

  fireEvent.click(screen.getByTestId('crop-zoom-in'));
  fireEvent.click(screen.getByTestId('crop-zoom-in'));
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(2));
  const second = drawn[2];
  expect(second!).toBeLessThan(first!);
});

it('1 倍到底（缩小禁用）、4 倍到顶（放大禁用）；复位在顶也可用（归位）', async () => {
  await renderCropper();
  expect((screen.getByTestId('crop-zoom-out') as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId('crop-zoom-in'));
  expect(screen.getByText('400%')).toBeTruthy();
  expect((screen.getByTestId('crop-zoom-in') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '复位' }));
  await waitFor(() => expect((screen.getByTestId('crop-zoom-out') as HTMLButtonElement).disabled).toBe(true));
});

// D59：封面链路要横幅比例。21:9 预设下取的区域必须 ≈ 21:9，框不是圆形。
it('D59：21:9 预设取出的是 21:9 矩形（框非圆、有比例选择器）', async () => {
  const out = await renderCropper({ aspect: 21 / 9, aspectOptions: [{ label: '21:9', value: 21 / 9 }] });
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  const [sx, sy, sw, sh] = drawn;
  expect(sw).toBeLessThanOrEqual(NATURAL.width);
  expect(sh).toBeLessThanOrEqual(NATURAL.height);
  expect(Math.abs(sw! / sh! - 21 / 9)).toBeLessThan(0.05);
  expect(sx).toBeGreaterThanOrEqual(0);
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(screen.getByText('裁切比例')).toBeTruthy();
  expect(screen.getByTestId('crop-frame').className).not.toContain('rounded-full');
});

it('长边压到 maxEdge：输出宽 ≤ 512', async () => {
  const out = await renderCropper({ maxEdge: 512 });
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  expect(drawn[6]!).toBeLessThanOrEqual(512.01);
});

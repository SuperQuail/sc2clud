import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageCropper } from './image-cropper';

// D23（用户 2026-10-15）：头像选图后弹裁剪框选启用区域。
//
// jsdom 既没有 createImageBitmap 也没有 canvas 编码器 —— 替掉两头，留下**中间的 drawImage 参数**：
// 那正是「用户框的那一块」与「存下去的字节」之间的唯一契约，也正是裁剪最容易错的地方
// （取到框外 / 取整张 / 缩放没进裁切）。

const NATURAL = { width: 1000, height: 500 };
let drawn: number[] = [];

function stubBitmap() {
  vi.stubGlobal('createImageBitmap', async () => ({ ...NATURAL, close: () => {} }));
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: (_src: unknown, ...rest: number[]) => {
      drawn = rest;
    },
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob([new Uint8Array(128)], { type: 'image/webp' }));
  };
}
// 方框的实际边长来自 getBoundingClientRect（jsdom 不算版面）：钉成 300 才能算出预期的那一块。
function stubFrame(width = 300) {
  Element.prototype.getBoundingClientRect = (() =>
    ({ width, height: width, top: 0, left: 0, right: width, bottom: width, x: 0, y: 0, toJSON: () => ({}) })) as unknown as typeof Element.prototype.getBoundingClientRect;
}

afterEach(() => {
  vi.unstubAllGlobals();
  drawn = [];
});

/** 选中的原图：一个 blob（真站从 <input type=file> 来） */
const file = () => new File([new Uint8Array(1024)], 'shot.png', { type: 'image/png' });

async function renderCropper() {
  stubBitmap();
  stubFrame();
  const out: Array<{ size: number; type: string }> = [];
  render(<ImageCropper source={file()} onCropped={(b) => out.push({ size: b.size, type: b.type })} onCancel={() => {}} />);
  // 等图片读完（确认键那时才可用）
  await waitFor(() => expect((screen.getByTestId('crop-confirm') as HTMLButtonElement).disabled).toBe(false));
  return out;
}

it('弹层里是照片与两个动作，确认后交回裁剪结果', async () => {
  const out = await renderCropper();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByAltText('待裁剪的图')).toBeTruthy();

  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));
  expect(out[0]!.type).toBe('image/webp');
  expect(out[0]!.size).toBeGreaterThan(0);
});

// 核心：取的那一块必须是**方**的、而且在原图内（1000×500 的横图 → 最多 500）。
it('取的区域是原图内的正方形（横图按高取满）', async () => {
  const out = await renderCropper();
  fireEvent.click(screen.getByTestId('crop-confirm'));
  await waitFor(() => expect(out.length).toBe(1));

  const [sx, sy, sw, sh] = drawn;
  expect(sw).toBeCloseTo(sh!, 6); // 正方形
  expect(sw).toBeLessThanOrEqual(NATURAL.height); // 不超出矮的那一边
  expect(sx).toBeGreaterThanOrEqual(0);
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(sx! + sw!).toBeLessThanOrEqual(NATURAL.width);
  expect(sy! + sh!).toBeLessThanOrEqual(NATURAL.height);
});

it('放大真的进到裁切里：放大之后取的源区域更小（不只是看着变大）', async () => {
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

it('缩小到 1 倍就到底（按钮禁用），放大到 4 倍就到顶', async () => {
  await renderCropper();
  expect((screen.getByTestId('crop-zoom-out') as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId('crop-zoom-in'));
  expect(screen.getByText('400%')).toBeTruthy();
  expect((screen.getByTestId('crop-zoom-in') as HTMLButtonElement).disabled).toBe(true);
});

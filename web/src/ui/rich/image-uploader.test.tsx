import { expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ImageUploader, type UploadedImage } from './image-uploader';

// D1（2026-10-14 用户实测）：收款码选 1.3MB 的图 —— 现在**直接拒**，而且同一句提示**出现两次**。
//
// 验收面有两半，都在这个文件里钉住：
//   ① 体积上限（maxSize）不是「压缩后的目标」：1.3MB 的原图必须**被压缩后收下**（压缩目标走 targetBytes）；
//   ② 提示只有一份 —— 控件内部的 error 与宿主的 onError **各画一次**就是重复渲染（用户原话「出现两次」）。
//
// jsdom 既没有 createImageBitmap 也没有 canvas 编码器：两者都替掉，只留「压缩会变小」这一个事实。

/** 压缩比 1/4：1300000 -> 325000，与真实 WebP 压缩后的量级同阶。 */
vi.stubGlobal('createImageBitmap', async () => ({ width: 1080, height: 1080, close: () => {} }));
HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
  cb(new Blob([new Uint8Array(this.width * this.height * 0.25)], { type: 'image/webp' }));
};

/** 选一个文件：input.files 是只读的，jsdom 30 又没有 DataTransfer，所以按数组形状直接定义它。 */
async function pick(input: HTMLInputElement, file: File) {
  const list = Object.assign([file], { item: (i: number) => (i === 0 ? file : null) });
  Object.defineProperty(input, 'files', { configurable: true, value: list });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function Harness({ onError, size, target }: { onError?: (m: string) => void; size: number; target?: number }) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  // 宿主与真站一样：把上传器给的提示**画出来**（payment-channels / profile 都是这个形状）
  const [hostError, setHostError] = useState<string | null>(null);
  return (
    <>
      <ImageUploader
        variant='avatar'
        label='选择收款码图片'
        images={images}
        onChange={setImages}
        maxSize={size}
        targetBytes={target}
        onError={(m) => {
          setHostError(m);
          onError?.(m);
        }}
      />
      {hostError ? <p role='alert'>{hostError}</p> : null}
      {images[0] ? <span data-testid='picked-size'>{images[0].size}</span> : null}
    </>
  );
}

// 真站那一格的参数：可压缩上限取头像那一档（10MB），成品目标 480KB，服务的硬上限 512KB。
const QR_LIMIT = 512 * 1024;
const QR_TARGET = 480 * 1024;

it('1.3MB 的收款码图被压缩后收下（不再直接拒）', async () => {
  const { container } = render(<Harness size={10 * 1024 * 1024} target={QR_TARGET} />);
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  const big = new File([new Uint8Array(1_300_000)], '收款码.png', { type: 'image/png' });
  expect(big.size).toBe(1_300_000);

  await pick(input, big);

  // 旧行为：maxSize=512KB 时这张图在 planImages 里就被判太大 → 什么也不加、只报一句「不能超过 0.5MB」
  expect(screen.queryByRole('img', { name: '已选头像' })).toBeTruthy();
  // 而且交出去的是**压缩后**的字节（1300000 -> 291600），不是原图
  const picked = Number(screen.getByTestId('picked-size').textContent);
  expect(picked).toBeLessThan(QR_LIMIT);
  expect(picked).toBeLessThan(big.size);
});

it('提示只出现一次：太大时被拒，onError 给一句、页面只有一行 alert', async () => {
  const seen: string[] = [];
  const { container } = render(<Harness size={1} onError={(m) => seen.push(m)} />);
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  // 上限 1 字节：任何真文件都超，走「太大」这一支
  await pick(input, new File([new Uint8Array(2)], 'too-big.png', { type: 'image/png' }));

  expect(seen[0]).toContain('too-big.png');
  // 旧行为：控件内部还画一行同样的字 → 两行 alert（D1 的「同一句提示出现两次」）
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

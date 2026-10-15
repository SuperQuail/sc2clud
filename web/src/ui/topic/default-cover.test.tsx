import { expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DefaultCover, DEFAULT_COVER_ART } from './default-cover';

// 用户 2026-10-15 判定：没有封面时落的「首字 + 由 slug 定的色相」**不是他要的**
// （原话：「完全没有关联的字」—— 首页卡片上就是一个大大的「原」「工」「自」）。
// 改成美术资产里的一张弥音图。
//
// 两条口径分开钉，因为它们坏起来是两种病：
//   ① 走 **assetUrl()**（public/art 的拼法）—— 走成 imagePath('/art/…') 就是 D27 那种裂图；
//      真封面（/img/<hash>）才是 imagePath，两者不许混。
//   ② 是**一张真图**：object-cover（不是 contain/歪比例）+ alt=''（装饰性，不抢标题的读屏）。
it('默认封面走 assetUrl（public/art 的拼法），不是 imagePath', () => {
  const { container } = render(<DefaultCover />);
  const img = container.querySelector('img');
  expect(img?.getAttribute('src')).toBe('/art/' + DEFAULT_COVER_ART);
  expect(img?.className).toContain('object-cover');
  expect(img?.getAttribute('alt')).toBe('');
  // 盖满容器（尺寸由调用方的格子给），不是自带一个固定尺寸
  expect(img?.className).toContain('absolute');
  expect(img?.className).toContain('inset-0');
});

it('画在用它的格子里：absolute inset-0，不自带尺寸、自带圆角由调用方给', () => {
  const { container } = render(<DefaultCover className='opacity-50' />);
  const img = container.querySelector('img');
  expect(img?.className).toContain('opacity-50');
  // 容器自己不该再写死 size-*（那会把 board rail 的 20px 与卡片的 16:9 一起写死）
  expect(container.firstElementChild?.className).not.toMatch(/\bsize-\d/);
});

it('默认美术是弥音的那张方图（封面位是宽幅，靠 object-cover 居中裁）', () => {
  expect(DEFAULT_COVER_ART).toBe('miyin-portrait-320.webp');
});

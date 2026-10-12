import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Ring UI 依赖这些浏览器 API，jsdom 没有：只补测试环境，不进产品代码
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});

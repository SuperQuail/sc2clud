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
// jsdom 没实现 <dialog> 的模态方法（实测 showModal 是 undefined，调用直接 TypeError），
// 而 Ring UI 的 Dialog 依赖它（dialog.js:103 的 this.nativeDialog.current.showModal()）。
// 补的是**浏览器本来就有的行为**，不是替产品代码兜底：showModal 置 open、close 清掉它并派发 close 事件，
// 这样「弹层到底有没有打开」在 jsdom 里也能被断言（ring-ui/components/dialog 的 role="dialog" 由此可见）。
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

afterEach(() => {
  cleanup();
});

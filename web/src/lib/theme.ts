export type Theme = 'light' | 'dark';

const KEY = 'theme';

// 首屏主题由 index.html 的内联脚本设定，这里只负责切换与持久化
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Ring UI 的暗色是类名，不是 data-theme：两边必须一起切，否则控件与页面一半深一半浅
  root.classList.toggle('ring-ui-theme-dark', theme === 'dark');
  localStorage.setItem(KEY, theme);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

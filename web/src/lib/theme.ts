export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

const KEY = 'theme';

// 首屏主题由 index.html / devroom.html 的内联脚本设定（避免闪白），这里负责切换与持久化
export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function themePreference(): ThemePreference {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'; // 默认跟随系统
}

export function resolvedTheme(pref: ThemePreference = themePreference()): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  const theme = resolvedTheme(pref);
  root.dataset.theme = theme;
  root.dataset.themePreference = pref;
  // Ring UI 的暗色是类名、我们的令牌是 data-theme：两边必须一起切，否则一半深一半浅
  root.classList.toggle('ring-ui-theme-dark', theme === 'dark');
  localStorage.setItem(KEY, pref);
}

/** 偏好为 system 时跟随系统切换；返回取消订阅函数 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (themePreference() === 'system') {
      applyTheme('system');
      onChange(systemTheme());
    }
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

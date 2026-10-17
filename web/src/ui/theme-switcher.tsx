import { useEffect, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { applyTheme, themePreference, watchSystemTheme, type ThemePreference } from '@/lib/theme';

// 一个按钮，点击在「日间 → 夜间 → 跟随系统」之间循环。
// 不做并排三个图标：那是设置面板的形态；日常只需要一个开关。要精确选择时用长按/设置页（以后再说）。
const ORDER: ThemePreference[] = ['light', 'dark', 'system'];
const LABEL: Record<ThemePreference, string> = { light: '日间', dark: '夜间', system: '跟随系统' };
const ICON: Record<ThemePreference, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

export function ThemeSwitcher() {
  const [pref, setPref] = useState<ThemePreference>(() => themePreference());

  // 跟随系统时，系统一改就跟着变
  useEffect(() => watchSystemTheme(() => setPref(themePreference())), []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
    applyTheme(next);
    setPref(next);
  }

  const Icon = ICON[pref];
  return (
    <Button
      icon={Icon}
      onClick={cycle}
      aria-label={'主题：' + LABEL[pref] + '，点击切换'}
      title={'主题：' + LABEL[pref] + '（点击切换）'}
    />
  );
}

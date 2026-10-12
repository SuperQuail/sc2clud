import { useEffect, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { Monitor, Moon, Sun } from 'lucide-react';
import { applyTheme, themePreference, watchSystemTheme, type ThemePreference } from '@/lib/theme';

// 日间 / 夜间 / 跟随系统。我们自己的组合件（Ring UI 没有等价物），所以放 src/ui。
// 属于设计语言 A（Ring UI 拼成）：主题切换是「设置」，不是消费内容。
const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: '日间', Icon: Sun },
  { value: 'dark', label: '夜间', Icon: Moon },
  { value: 'system', label: '跟随系统', Icon: Monitor },
];

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [pref, setPref] = useState<ThemePreference>(() => themePreference());

  // 跟随系统时，系统一改就跟着变
  useEffect(() => watchSystemTheme(() => setPref(themePreference())), []);

  function choose(next: ThemePreference) {
    applyTheme(next);
    setPref(next);
  }

  return (
    <ButtonSet aria-label='主题'>
      {OPTIONS.map(({ value, label, Icon }) => (
        <Button
          key={value}
          active={pref === value}
          aria-pressed={pref === value}
          aria-label={label}
          title={label}
          icon={Icon}
          onClick={() => choose(value)}
        >
          {compact ? null : label}
        </Button>
      ))}
    </ButtonSet>
  );
}

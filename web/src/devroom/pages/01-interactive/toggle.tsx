import { useState } from 'react';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Line, Pair } from '@/devroom/kit';
import { VividSwitch } from '@/ui/vivid/switch';

export function TogglePair() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  return (
    <Pair
      name='开关 Toggle'
      note='B 系 28×48px 圆角开关（原生 role=switch，旋钮走 --switch-knob，两种主题都浅色）；A 系是 checkbox 输入，标签用 children。'
      user={
        <Line label='开 / 关 / 禁用'>
          <VividSwitch checked={on} onChange={setOn} label='接收回复通知' hint='有人回复你时提醒' />
          <VividSwitch checked={off} onChange={setOff} label='公开我的收藏' />
          <VividSwitch checked disabled onChange={() => {}} label='不可用' />
        </Line>
      }
      dev={
        <Line label='开 / 关 / 禁用'>
          <Toggle checked={on} onChange={(e) => setOn(e.target.checked)}>接收回复通知</Toggle>
          <Toggle checked={off} onChange={(e) => setOff(e.target.checked)}>公开我的收藏</Toggle>
          <Toggle checked disabled onChange={() => {}}>不可用</Toggle>
        </Line>
      }
    />
  );
}

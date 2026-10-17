import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';

// 这是本项目最大的未知：Ring UI 是 React 18 时代的库，我们在 React 19 上用。
// 这条测试红了就说明不能用，必须当场换方案，而不是等上线才发现。
it('Ring UI 的 Button 能在 React 19 下渲染并响应点击', () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>点我</Button>);
  const el = screen.getByText('点我');
  expect(el).toBeTruthy();
  el.click();
  expect(onClick).toHaveBeenCalled();
});

it('Ring UI 的 Input 能在 React 19 下渲染', () => {
  render(<Input value='x' onChange={() => {}} />);
  expect(screen.getByDisplayValue('x')).toBeTruthy();
});

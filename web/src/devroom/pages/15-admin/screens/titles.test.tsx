import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TitlesScreen } from './titles';
import type { Title } from '@/lib/api/admin';

// 头衔屏的两条屏内行为（2026-10-15 用户实测「新建头衔创建后消失」的根因就在第一条）：
//   ① 提交**失败**时弹窗必须留着 —— 原来无论成败都立刻关窗，人只看到「弹窗关了」＝以为建好了，
//      而列表里没有那一行，于是观感是「创建后消失」；
//   ② 建成才关窗。
// 取色用库（react-colorful）而不是自造控件：这里顺带钉住它真的被渲染（不自造第二套）。
const title: Title = {
  id: 't-1',
  key: 'huangdi',
  name: '皇帝',
  color: '#d7b50f',
  description: '灵梦专属',
  archived_at: null,
};

function Harness({ ok, errorText = '' }: { ok: boolean; errorText?: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <TitlesScreen
      titles={[title]}
      canManage
      onCreate={async () => {
        if (!ok) {
          setError(errorText);
          return false;
        }
        return true;
      }}
      createError={error}
      onUpdate={() => {}}
    />
  );
}

function openAndSubmit() {
  fireEvent.click(screen.getByRole('button', { name: '新建头衔' }));
  // 取色器来自 react-colorful（类是库自己的约定）
  expect(document.querySelector('.react-colorful')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('speedrunner'), { target: { value: 'sg_king' } });
  fireEvent.change(screen.getByPlaceholderText('速通达人'), { target: { value: '速通达人' } });
  fireEvent.click(screen.getByTestId('title-create-submit'));
}

it('新建失败：弹窗不关，失败理由留在弹窗里（「创建后消失」的根因）', async () => {
  render(<Harness ok={false} errorText='参数错误（key：只能是小写字母、数字、下划线，1-32 位）' />);
  openAndSubmit();
  await waitFor(() => expect(screen.getByTestId('title-create-error')).toBeTruthy());
  // 窗还开着：提交按钮与刚填的值都还在（人可以直接改，不必重新打开重填）
  expect(screen.getByTestId('title-create-submit')).toBeTruthy();
  expect((screen.getByPlaceholderText('speedrunner') as HTMLInputElement).value).toBe('sg_king');
});

it('建成才关窗', async () => {
  render(<Harness ok />);
  openAndSubmit();
  await waitFor(() => expect(screen.queryByTestId('title-create-submit')).toBeNull());
});

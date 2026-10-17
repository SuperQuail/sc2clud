import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DiagnosticsScreen, isDebugOff, type DiagnosticsProps } from './diagnostics';
import type { Diagnostics } from '@/lib/api/admin';

// D13：debug 关闭时后端**故意**回 404 common.not_found（C3），不是坏了。但呈现方式让它像坏了 ——
// 界面上画着一张红色 404 卡 + 一排「—」的空指标格。验收：这一档**只留一句说明**。
//
// 为什么判据钉在 isDebugOff + role=alert 的数量上：
//   · 「看起来像坏了」不是文案问题，是**画了几张卡**的问题 —— 所以断言数卡片（role=alert）与空指标格（data-testid），
//     而不是断言某句文案在不在（改文案不该弄坏断言）。
//   · 404 与「路由真的不在」是两件事，判据必须是后端错误码 common.not_found，不是状态码（见 isDebugOff 的注释）。

const CHECK = (name: string, status: string): Diagnostics['checks'][number] => ({
  name, status, detail: '', ms: 3, ok: status === 'ok',
});
const DATA: Diagnostics = {
  debug_enabled: true, version: 'dev-1', started_at: '2026-10-12T02:00:00Z', readonly: true,
  checks: [CHECK('权限点集合一致性', 'ok'), CHECK('数据库迁移版本', 'fail')],
  total: 2, failed: 1,
};

function renderScreen(props: Partial<DiagnosticsProps>) {
  render(<DiagnosticsScreen data={null} canSetting {...props} />);
}

it('debug 关闭（404 common.not_found）：只留一句说明，不画 404 卡、不画空指标格', () => {
  renderScreen({
    error: { message: '内容不存在（编号 req-shot）', status: 404, code: 'common.not_found' },
  });
  expect(screen.queryAllByRole('alert')).toHaveLength(0);
  expect(screen.queryByTestId('diag-stats')).toBeNull();
  expect(screen.getByTestId('diag-debug-off')).toBeTruthy();
});

it('别的 404（不是 debug 开关）：仍然如实报错，不许拿「关掉了」糊过去', () => {
  renderScreen({ error: { message: '接口不存在', status: 404, code: 'common.route_not_found' } });
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  expect(screen.queryByTestId('diag-debug-off')).toBeNull();
});

it('debug 打开：正常显示指标与检查表（这一档不许被上面那条改动影响）', () => {
  renderScreen({ data: DATA });
  expect(screen.getByTestId('diag-stats')).toBeTruthy();
  expect(screen.getByText('权限点集合一致性')).toBeTruthy();
  expect(screen.queryByTestId('diag-debug-off')).toBeNull();
});

it('isDebugOff 只认 common.not_found：状态码 404 不够', () => {
  expect(isDebugOff({ code: 'common.not_found' })).toBe(true);
  expect(isDebugOff({ code: 'common.route_not_found' })).toBe(false);
  expect(isDebugOff({ code: '' })).toBe(false);
  expect(isDebugOff(null)).toBe(false);
});

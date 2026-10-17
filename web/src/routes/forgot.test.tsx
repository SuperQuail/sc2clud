import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { ForgotPage } from './forgot';

// G3：找回密码整页。这一条盯的是**字段名**（本仓库最高频的事故：契约两侧各写一份、各自的测试都过）：
//   POST /auth/password/forgot      { email }
//   POST /auth/password/verify-code { email, code }        → { reset_ticket }
//   POST /auth/password/reset       { reset_ticket, new_password }
// 真源：forum/internal/auth/handler.go:114-121（forgotReq / verifyCodeReq / resetReq）。
// 曾经踩过的同族坑：发 `token` 而后端要 `reset_ticket` —— 接口 400、页面提示「验证码不对」。

type WriteCall = { method: string; url: string; body: unknown };

function mockAuth(writes: WriteCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const p = new URL(u, 'http://x').pathname;
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method && init.method !== 'GET') {
        writes.push({ method: init.method, url: u, body: init.body ? JSON.parse(String(init.body)) : null });
        if (p.endsWith('/auth/password/verify-code')) return json({ reset_ticket: 'ticket-1' });
        return json(null);
      }
      if (p.endsWith('/api/v1/site')) return json({ name: 'SC2clud', announcements: [], banner: null });
      if (p.endsWith('/api/v1/me')) return json(null);
      return new Response(JSON.stringify({ error: { code: 'common.not_found', message: u } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderForgot() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/forgot']}>
        <Routes>
          <Route path='/forgot' element={<ForgotPage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('三步依次发 forgot / verify-code / reset，字段名与后端 req 结构逐字一致', async () => {
  const writes: WriteCall[] = [];
  mockAuth(writes);
  renderForgot();

  // 第 1 步：邮箱 → 恒 200，进第 2 步
  fireEvent.change(await screen.findByLabelText(/邮箱/), { target: { value: 'demo@example.com' } });
  fireEvent.click(screen.getByTestId('forgot-send'));
  expect(await screen.findByText(/验证码已发到/)).toBeTruthy();

  // 第 2 步：6 位码 + 新密码 + 确认
  fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-1' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password-1' } });
  fireEvent.click(screen.getByTestId('forgot-submit'));

  // 成功页
  expect(await screen.findByText('密码已重置')).toBeTruthy();

  expect(writes.map((w) => new URL(w.url, 'http://x').pathname)).toEqual([
    '/api/v1/auth/password/forgot',
    '/api/v1/auth/password/verify-code',
    '/api/v1/auth/password/reset',
  ]);
  // **字段名逐字**：email / email+code / reset_ticket+new_password
  expect(writes[0]!.body).toEqual({ email: 'demo@example.com' });
  expect(writes[1]!.body).toEqual({ email: 'demo@example.com', code: '123456' });
  expect(writes[2]!.body).toEqual({ reset_ticket: 'ticket-1', new_password: 'new-password-1' });
});

it('第一次换票据后不再重复请求：两个字段都填好时只发一条 reset（票据只消费一次）', async () => {
  const writes: WriteCall[] = [];
  mockAuth(writes);
  renderForgot();
  fireEvent.change(await screen.findByLabelText(/邮箱/), { target: { value: 'demo@example.com' } });
  fireEvent.click(screen.getByTestId('forgot-send'));
  fireEvent.change(await screen.findByLabelText('验证码'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-1' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password-1' } });
  // 第一次点：还没票据 → 只发 verify-code
  fireEvent.click(screen.getByTestId('forgot-submit'));
  await screen.findByText('密码已重置');
  const codes = writes.filter((w) => w.url.includes('verify-code')).length;
  expect(codes).toBe(1);
});

import { api } from './client';

// 认证与会话（v2 §21.2 auth 段）。**登录态的唯一真源是 GET /api/v1/me**：
// 游客返回 200 + data:null，所以这里没有「未登录 = 报错」这种分支（前端方案 §5.4）。
// 前端不存任何 token：会话是 HttpOnly Cookie（§21.1 认证一行）。

export type Session = {
  id: string;
  handle: string;
  nickname: string;
  avatar?: string | null;
  email_verified: boolean;
  bio?: string | null;
  /** 算好的权限点集合（RBAC权限树设计.md §5：前端只决定显不显示） */
  perms: string[];
  board_ids?: number[];
  is_super: boolean;
  wallet_cents?: number;
  unread_count?: number;
  /** 点对点追加的权限（含到期与理由） */
  extra?: Array<{ key: string; reason: string; expires_at: string | null }>;
  role?: { key: string; name: string } | null;
  /** 未激活账号不能写（全站唯一的写闸门）：激活前 activated_at 为空 */
  activated_at?: string | null;
};

export type Captcha = { id: string; image_base64: string };

export function fetchMe(signal?: AbortSignal): Promise<Session | null> {
  return api<Session | null>('me', { signal });
}

export function fetchCaptcha(signal?: AbortSignal): Promise<Captcha> {
  return api<Captcha>('captcha', { signal });
}

// captcha_id 是「这一张图」的身份：服务端按它找到答案，无论对错都立刻作废（一次性）。
// 只交 answer 的话服务端没法把答案和某道题对上 —— mode=always / on_failure 就会永远校验不过。
export function login(body: {
  username: string;
  password: string;
  captcha?: string;
  captcha_id?: string;
}): Promise<Session> {
  return api<Session>('auth/login', { method: 'POST', body });
}

export function logout(): Promise<void> {
  return api<void>('auth/logout', { method: 'POST' });
}

export function register(body: {
  username: string;
  /** 显示名；留空表示没设，服务端原样存空串，读的时候回落到 username（不写回） */
  nickname?: string;
  email: string;
  password: string;
  captcha?: string;
  captcha_id?: string;
}): Promise<{ handle: string }> {
  return api<{ handle: string }>('auth/register', { method: 'POST', body });
}

/** 邮箱激活走 6 位验证码（后端开工前拍板 §11：不发链接），所以提交的是文本 token */
export function verifyEmail(token: string): Promise<void> {
  return api<void>('auth/email/verify', { method: 'POST', body: { token } });
}

export function resendVerification(): Promise<void> {
  return api<void>('auth/email/resend', { method: 'POST' });
}

export function forgotPassword(email: string): Promise<void> {
  return api<void>('auth/password/forgot', { method: 'POST', body: { email } });
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return api<void>('auth/password/reset', { method: 'POST', body: { token, new_password: newPassword } });
}

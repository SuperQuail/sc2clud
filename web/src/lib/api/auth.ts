import { api } from './client';
import { appPath } from '@/lib/url';

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

export async function fetchMe(signal?: AbortSignal): Promise<Session | null> {
  const s = await api<Session | null>('me', { signal });
  // 后端给的 avatar 是**站内绝对路径**（/img/<hash>）。站点可能挂在 /dev/ 下，前端必须补上 base，
  // 否则浏览器会去站外拿 /img/… → 顶栏头像 404（dev 上实测就是这个现象）。
  return s && s.avatar ? { ...s, avatar: appPath(s.avatar) } : s;
}

export function fetchCaptcha(signal?: AbortSignal): Promise<Captcha> {
  return api<Captcha>('captcha', { signal });
}

// 图形验证码：**id + answer 成对**校验（服务端按 id 找到答案，无论对错都立刻作废）。
// captcha_id 是「这一张图」的身份，不是登录态；只交 answer 的话服务端没法把答案和某道题对上 ——
// mode=always / on_failure 就会永远校验不过。
type CaptchaInput = { captcha?: string; captcha_id?: string };

/**
 * 入参沿用界面里的 captcha，出网时改成后端契约的 captcha_answer（auth/handler.go:77-85）。
 *
 * 泛型：调用方可以带自己的字段（例如 login 的 `login`），这里只做「改名」这一件事、
 * 不吞掉调用方的字段类型（否则调用方传错字段名，类型检查反而看不见）。
 */
function withCaptcha<T extends CaptchaInput>(body: T): Omit<T, 'captcha'> & { captcha_answer?: string } {
  const { captcha, ...rest } = body;
  return (captcha === undefined ? rest : { ...rest, captcha_answer: captcha }) as Omit<T, 'captcha'> & { captcha_answer?: string };
}

export function login(body: { username: string; password: string } & CaptchaInput): Promise<Session> {
  // 后端 loginReq 的字段名是 **`login`**，不是 `username`（auth/handler.go:81-86，`binding:"required"`）。
  // 送错名字 -> login 为空 -> **400 参数错误**（而不是 401），**浏览器里的登录从来就没成功过**。
  // 2026-10-13 用户实测：填对用户名口令仍报「参数错误」，且错误码每次不同（那是 request_id）。
  //
  // 入参沿用界面里的 `username`（调用点不用改），只在这里改名 —— 与 withCaptcha 同一个套路。
  const { username, ...rest } = body;
  return api<Session>('auth/login', { method: 'POST', body: withCaptcha({ login: username, ...rest }) });
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
} & CaptchaInput): Promise<{ handle: string }> {
  return api<{ handle: string }>('auth/register', { method: 'POST', body: withCaptcha(body) });
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

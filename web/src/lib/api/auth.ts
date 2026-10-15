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

/**
 * 头像 URL 的唯一换算口。
 *
 * 契约是**站内绝对路径** `/img/<hash>`（与 GET /users/{handle} 同一份实现）。
 * 但 `/me` 一度只下发**裸 64 位哈希**（D2，2026-10-14 dev 实测）：补上 base 之后变成 `/dev/<hash>` → 404，
 * 症状是「顶栏头像裂图、而个人主页正常」——**同一个头像在两个地方长得不一样**。
 * 后端已改成走 media 拼路径；这一层对两种形状都兜住：一个端点写错不该在界面上裂一张图。
 */
function avatarSrc(v: string): string {
  return appPath(/^[0-9a-f]{64}$/i.test(v) ? 'img/' + v : v);
}

export async function fetchMe(signal?: AbortSignal): Promise<Session | null> {
  const s = await api<Session | null>('me', { signal });
  // 站点可能挂在 /dev/ 下，前端必须补上 base，否则浏览器会去站外拿 /img/… → 顶栏头像 404。
  return s && s.avatar ? { ...s, avatar: avatarSrc(s.avatar) } : s;
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
} & CaptchaInput): Promise<{
  /** 后端 RegisterResult 的三个字段（auth/service.go）；id/email_verified 前端暂时不用 */
  handle: string;
  /** false = 站长把自动激活关了（D29）：**不会发验证码**，注册后应显示「等管理员激活」，
   *  而不是「请输入验证码」。这个字段后端一直在发，是前端原先把它丢掉了。 */
  auto_activate: boolean;
}> {
  return api('auth/register', { method: 'POST', body: withCaptcha(body) });
}

// ── 验证码类的三个端点共用一个形状 ───────────────────────────────────────────
// 真源 forum/internal/auth/handler.go:88-106 的 verifyCodeReq：`code` 必填，身份走
// **username 或 email 二选一**（都给或都不给都是 400）。
//
// 2026-10-14 修：原先 verifyEmail/forgot 走的是「token」这个不存在的字段名 ——
// **邮箱激活因此 100% 400**（页面提示「激活码不对」，其实请求根本没被受理）；
// resetPassword 发的 `token` 也不是后端的 `reset_ticket`。与本文件 login 那条同族。
function loginOf(who: string): { username: string } | { email: string } {
  const v = who.trim();
  return v.includes('@') ? { email: v } : { username: v };
}

/** 邮箱激活：POST /auth/email/verify { username|email, code }（6 位验证码，拍板 §11 不发链接） */
export function verifyEmail(who: string, code: string): Promise<void> {
  return api<void>('auth/email/verify', { method: 'POST', body: { ...loginOf(who), code } });
}

/**
 * 重发激活码：POST /auth/email/resend。
 * **必须已登录**（handler.go:42 挂了 RequireLogin，服务端用会话里的人发信，不收用户名）——
 * 注册接口不建会话，所以「刚注册完就重发」在服务端是 401，页面要把这一点说清楚。
 */
export function resendVerification(): Promise<void> {
  return api<void>('auth/email/resend', { method: 'POST' });
}

export function forgotPassword(email: string): Promise<void> {
  return api<void>('auth/password/forgot', { method: 'POST', body: { email } });
}

/** 找回密码第一步：POST /auth/password/verify-code { username|email, code } -> 换取 reset_ticket */
export function verifyResetCode(who: string, code: string): Promise<{ reset_ticket: string }> {
  return api<{ reset_ticket: string }>('auth/password/verify-code', { method: 'POST', body: { ...loginOf(who), code } });
}

/** 找回密码第二步：真源 handler.go:112-115 的 resetReq{reset_ticket,new_password} */
export function resetPassword(resetTicket: string, newPassword: string): Promise<void> {
  return api<void>('auth/password/reset', {
    method: 'POST',
    body: { reset_ticket: resetTicket, new_password: newPassword },
  });
}

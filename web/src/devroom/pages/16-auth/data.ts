// F3 登录 / 注册 / 找回密码 / 邮箱验证 —— DevRoom 16-auth 的假数据与「情形」清单。
// 依据（按最新定案排）：
//   完全重构/后端开工前拍板.md §11「邮箱激活改成验证码而不是链接」（2026-10-12 定案，覆盖 §9 的「点链接」）；
//   §9.6「登录页必须覆盖的 7 种情形」；完全重构/后端设计/d2-auth.md §7（注册/登录）、§10（令牌）、§15（错误码）。
// 本页是**设计验证页**：数据写死在这里，不 fetch、不接 api client、不引 router。
//
// §11 带来的三处结构变化（别按旧稿做）：
//   ① 注册成功 → 落地到「输入验证码」页（不是「我们给你发了邮件」）；
//   ② verify 视图 = 输入 6 位验证码，成功后就地显示「已激活，去登录」；
//   ③ 找回密码 = 两步一页（输入验证码 → 设新密码），不再有「点邮件链接」的重置页。
export type AuthView = 'login' | 'register' | 'verify' | 'forgot';

export const AUTH_VIEWS: AuthView[] = ['login', 'register', 'verify', 'forgot'];

export const AUTH_VIEW_LABEL: Record<AuthView, string> = {
  login: '登录',
  register: '注册',
  verify: '输入验证码',
  forgot: '找回密码',
};

/** URL 里的别名：老稿的 view=reset（带 token 的重置页）已并入 forgot，view=code 就是 verify */
export const VIEW_ALIAS: Record<string, AuthView> = { code: 'verify', reset: 'forgot' };

/** 一种「情形」= 后端的某个真实返回；label 用于切换按钮，hint 说明它对应什么契约 */
export type Scene<Key extends string> = { key: Key; no: number; label: string; hint: string };

/** 登录页七种情形（拍板 §9.6 那张表逐条对应，顺序也照它） */
export type LoginScene = 'ok' | 'badCredentials' | 'banned' | 'pendingEmail' | 'pendingManual' | 'rateLimited' | 'captcha';

export const LOGIN_SCENES: Array<Scene<LoginScene>> = [
  { key: 'ok', no: 1, label: '正常', hint: '① 正常：用户名或邮箱 + 密码；需要图形验证码时才出现图块。' },
  { key: 'badCredentials', no: 2, label: '账号或密码错误', hint: '② 失败：401 auth.bad_credentials —— 不区分「用户不存在」和「密码错」，文案必须统一。' },
  { key: 'banned', no: 3, label: '账号已被封禁', hint: '③ 封禁：403「账号已被封禁」，不给具体原因，只给申诉口。' },
  { key: 'pendingEmail', no: 4, label: '未激活·已发验证码', hint: '④ 未激活且验证码已入队：登录照常成功（能读），页面直接给「输入验证码」入口 + 60 秒冷却的重新发送。' },
  { key: 'pendingManual', no: 5, label: '未激活·等管理员', hint: '⑤ 未激活且发不出去（无发信账号 / 额度满）：提示已通知管理员，用户随时可再点重新发送（成功即回到 ④）。' },
  { key: 'rateLimited', no: 6, label: '尝试过于频繁', hint: '⑥ 429：读 Retry-After，按钮禁用并显示剩余秒数；限流分「按 IP 10/分」与「按账号 5/分」两道。' },
  { key: 'captcha', no: 7, label: '需要图形验证码', hint: '⑦ 需要图形验证码（与邮箱验证码是两套机制，§11.6）：图块 + 输入框，可换一张；错误码 auth.captcha_required / auth.captcha_wrong。' },
];

export type RegisterScene = 'form' | 'fieldErrors';
export const REGISTER_SCENES: Array<Scene<RegisterScene>> = [
  { key: 'form', no: 1, label: '注册表单', hint: '① 正常：POST /auth/register { username, email, password, captcha? }，用户名 3-24 位且注册后不可改；成功后落地到「输入验证码」页。' },
  { key: 'fieldErrors', no: 2, label: '用户名/邮箱被占', hint: '② 服务端字段错误：409 auth.handle_taken / auth.email_taken，靠 error.fields 直接喂给对应输入框。' },
];

/** verify 视图 = 输入 6 位验证码（§11.2/§11.7） */
export type VerifyScene = 'input' | 'wrong' | 'rateLimited' | 'activated';
export const VERIFY_SCENES: Array<Scene<VerifyScene>> = [
  { key: 'input', no: 1, label: '输入验证码', hint: '① 正常：POST /auth/email/verify { username, code }；码 6 位数字、10 分钟有效。' },
  { key: 'wrong', no: 2, label: '验证码不正确', hint: '② 统一失败文案「验证码不正确或已过期」——不区分输错与过期，也不显示「还剩几次」（§11.4）。' },
  { key: 'rateLimited', no: 3, label: '尝试过于频繁', hint: '③ 15 分钟内累计 10 次失败 → 429 + Retry-After。' },
  { key: 'activated', no: 4, label: '已激活', hint: '④ 成功：email_verified_at 与 activated_at 同时落、activation_pending 置 NULL，就地显示「已激活，去登录」。' },
];

/** forgot 视图 = 两步一页：输入验证码 → 设新密码（§11.7） */
export type ForgotScene = 'request' | 'code' | 'wrong' | 'rateLimited' | 'done';
export const FORGOT_SCENES: Array<Scene<ForgotScene>> = [
  { key: 'request', no: 1, label: '填邮箱', hint: '① 第一步：POST /auth/password/forgot { email }，恒 200（不暴露邮箱是否存在），限流 3 次/小时。' },
  { key: 'code', no: 2, label: '验证码 + 新密码', hint: '② 第二步：验证码与新密码一屏提交，后端一个事务里校验码 + 改密码 + 删全部会话。' },
  { key: 'wrong', no: 3, label: '验证码不正确', hint: '③ 失败文案与激活页同一句「验证码不正确或已过期」：邮箱不存在、码错、码过期都走它，否则这一步就成了「查邮箱有没有注册」的工具。' },
  { key: 'rateLimited', no: 4, label: '尝试过于频繁', hint: '④ 429 + Retry-After（重发 1 次/分钟、3 次/小时；15 分钟内 10 次校验失败也 429）。' },
  { key: 'done', no: 5, label: '重置成功', hint: '⑤ 成功：该账号全部设备的会话被删，要用新密码重新登录。' },
];

/**
 * 页面里出现的假账号。
 *
 * ⚠️ **这里的每个值都必须是编的。** 2026-10-13：这个对象原来放的是某位社区成员的真实邮箱（从旧站截图抄来的），
 * 而它被构建进 bundle 后**公开部署在 /dev/devroom/** —— 一个真实邮箱挂在公网上会被爬去做垃圾邮件。
 * 注释当时还写着「邮箱是编的」，是假的。**往这个对象里填任何真实信息之前先想清楚它会被公开。**
 */
export const MOCK_ACCOUNT = {
  username: 'demo-admin',
  nickname: '示范管理员',
  email: 'demo@example.com',
  /** 验证码有效期（§11.4） */
  codeTtlMinutes: 10,
  /** 重新发送的冷却秒数（1 分钟 1 次） */
  resendCooldown: 60,
  /** 429 的 Retry-After 剩余秒数 */
  retryAfter: 42,
};

/** 图形验证码的假字符（真图由 GET /api/v1/captcha 返回 image_base64；与邮箱验证码无关） */
export const CAPTCHA_SAMPLES: string[][] = [
  ['7', 'K', '3', 'P'],
  ['M', '4', 'X', '9'],
  ['2', 'W', '6', 'R'],
];

/** 换一张图形验证码：设计页里就是在这几组假字符之间轮换 */
export function nextCaptcha(current: string[]): string[] {
  const i = CAPTCHA_SAMPLES.findIndex((s) => s.join('') === current.join(''));
  return CAPTCHA_SAMPLES[(i + 1) % CAPTCHA_SAMPLES.length]!;
}

/** 视图 → 情形清单（演示控制台用它渲染切换按钮） */
export const SCENES_BY_VIEW: Record<AuthView, ReadonlyArray<Scene<string>>> = {
  login: LOGIN_SCENES,
  register: REGISTER_SCENES,
  verify: VERIFY_SCENES,
  forgot: FORGOT_SCENES,
};

export const COPY = {
  siteName: 'SC2clud',
  siteTagline: '星际争霸战役社区',
  loginFooter: '登录遇到问题？在社区里私信管理员，或查看置顶的《新手指引》。',
  registerFooter: '注册即表示同意《社区公约》。用户名注册后不可修改，请谨慎起名。',
  codeFooter: '验证码是 6 位数字，10 分钟内有效；重新发送会让旧码立刻失效。',
  forgotFooter: '为了安全，重置成功后所有设备上的登录都会失效，需要用新密码重新登录。',
};

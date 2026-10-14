import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { PasswordField } from '@/ui/password-field';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { isApiError } from '@/lib/api/errors';
import { fetchCaptcha, fetchMe, login } from '@/lib/api/auth';

// 登录页（契约：POST /auth/login、GET /captcha、GET /me）。
// 房里的 LoginView 是七种情形的**设计稿**（走的是 mock 账号与演示控制台），产品页只取它的房子件：
// AuthShell / FormAlert / CaptchaField / PasswordField —— 同一份实现，不是两份（上线设计 P2 决策 2）。
// 登录成功后的两件事：queryClient.clear()（清掉上一个账号的缓存，前端方案 §5.4）+ 回跳 ?next=。
export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // next 是 **basename 相对**的路径（生成处用 routePath()）—— navigate() 会自己前置 basename。
  const next = params.get('next') ?? '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaSeed, setCaptchaSeed] = useState(0);

  const signIn = useMutation({
    mutationFn: () =>
      login({ username, password, captcha: captcha || undefined, captcha_id: captchaId || undefined }),
    onSuccess: async () => {
      queryClient.clear(); // 上一个账号的缓存必须清掉（同一台设备换人登录）
      await queryClient.fetchQuery({ queryKey: qk.me(), queryFn: ({ signal }) => fetchMe(signal) });
      void navigate(next, { replace: true });
    },
    onError: (e) => {
      // 验证码错 / 需要验证码：后端用 auth.captcha_required / auth.captcha_wrong 表达（§21.4）
      if (isApiError(e) && (e.code === 'auth.captcha_required' || e.code === 'auth.captcha_wrong')) {
        setCaptcha('');
        // 一道题只有一次机会（服务端无论对错都作废），所以出错必须换一张新的。
        setCaptchaSeed((n) => n + 1);
      }
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    signIn.mutate();
  }

  const err = signIn.error;
  const isCaptchaError = isApiError(err) && (err.code === 'auth.captcha_wrong' || err.code === 'auth.captcha_required');

  return (
    <AuthShell
      title='登录 SC2clud'
      subtitle='用社区账号继续，或先注册一个。'
      // 页脚只说真的能做的事（2026-10-14 改）：
      //   ① 找回密码**已接**（routes/forgot.tsx），原先那句「重置链路还没接…请管理员帮你重置」是假话；
      //   ② 申诉入口**已上线**（POST /api/v1/appeals 已落地），原先那句「后端不存在」也是假话 ——
      //      它正好把唯一可用的自救路径说成不存在（与 交接单 §4.B6 同一形状的缺陷）。
      footer={
        <>
          忘记密码？
          <a className='ml-1 underline' href={appPath('forgot')}>
            用注册邮箱自助重置
          </a>
          <br />
          <span>
            账号被封了（或被驳回了帖子）？
            <a className='ml-1 underline' href={appPath('appeal')}>
              提交申诉
            </a>
          </span>
        </>
      }
    >
      {err && !isCaptchaError ? (
        <FormAlert
          tone='error'
          title={isApiError(err) && err.status === 429 ? '尝试次数过多' : '没能登录'}
          description={errorText(err)}
        />
      ) : null}
      {isCaptchaError ? (
        // **两种错误要说两句话**：captcha_required =「你还没填」，captcha_wrong =「填错了」。
        // 2026-10-13 用户实测：只填了用户名与口令（页面上**根本没有验证码框**），页面却说「验证码不对」——
        // 把「我没收到」说成「你写错了」，人会一直重试输入，而不会去找那个还没出现的框。
        <FormAlert
          tone='error'
          title={err.code === 'auth.captcha_wrong' ? '验证码不对' : '请先填写图形验证码'}
          description={
            err.code === 'auth.captcha_wrong'
              ? '请按图片重新输入一次；连续错误会触发限流。'
              : '这道题是必须的：按图片填一次即可，看不清就点「换一张」。'
          }
        />
      ) : null}

      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <Input
          size={Size.FULL}
          label='用户名或邮箱'
          name='username'
          autoComplete='username'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={fieldError(err, 'username')}
          placeholder='用户名或注册邮箱'
          disabled={signIn.isPending}
        />
        <PasswordField
          label='密码'
          name='password'
          // 真页面必须给 autoComplete：密码管理器靠它认字段（房间里的设计稿刻意不传）
          autoComplete='current-password'
          value={password}
          onChange={setPassword}
          error={fieldError(err, 'password')}
        />
        {/* **验证码框常驻。** 原先是「后端要才画」（challenge 初值 false），于是 mode=always 下
            第一次提交必然 400 auth.captcha_required、框才冒出来 —— 用户以为自己填错了。
            mode=off 时服务端不看它、空着也能提交，所以常驻不挡人。 */}
        {(
          <ProductCaptcha
            value={captcha}
            onChange={setCaptcha}
            onChallenge={setCaptchaId}
          refreshKey={captchaSeed}
        />
        )}
        <Checkbox
          label='记住我（这台设备 7 天免登录）'
          checked={remember}
          onChange={(e) => setRemember(e.target.checked as boolean)}
        />
        <Button
          data-testid='login-submit'
          type='submit'
          primary
          inline={false}
          disabled={signIn.isPending || username === '' || password === ''}
          loader={signIn.isPending}
          className='w-full'
        >
          登录
        </Button>
      </form>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[12px]'>
        <span className='text-muted-foreground'>
          还没有账号？
          <a className='underline' href={appPath('register')}>
            注册
          </a>
        </span>
      </div>
    </AuthShell>
  );
}

/**
 * 真验证码：GET /captcha 给 { id, image_base64 }，而房子件 CaptchaField 吃的是字符数组（设计稿用字符块代替图）。
 * 所以这里只把「图 + 换一张」交给房子件之外的输入框：复用 Input 与 Button，不新造控件、也不改房子件的签名。
 * 已知：image_base64 可能是裸 base64 或完整 data URI，两种都要能显示。
 *
 * onChallenge 把这一张的 id 交出去：**校验是「id + answer」成对做的**（服务端按 id
 * 找到答案，无论对错都立刻作废），只交 answer 的话服务端没法把它和某一道题对上 ——
 * 那样 mode=always / on_failure 永远校验不过。id 是这一张图的身份，不是登录态。
 * refreshKey 变一次就换一张：一道题只有一次机会，校验失败后旧图已经作废，必须重取。
 */
export function ProductCaptcha({
  value,
  onChange,
  onChallenge,
  refreshKey,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onChallenge?: (id: string) => void;
  refreshKey?: number;
  error?: string | null;
}) {
  // 查询键 = 「第几张」。换一张按钮与上层的 refreshKey 都只是让它 +1。
  const [n, setN] = useState(0);
  const captcha = useCaptchaQuery(n + (refreshKey ?? 0));
  const fresh = captcha.data;
  // 图一到位就把这一张的 id 交出去：它是「这一张」的身份，换了图就换 id。
  useEffect(() => {
    if (fresh) onChallenge?.(fresh.id);
  }, [fresh, onChallenge]);
  return (
    <div className='flex flex-col gap-2'>
      <Input
        size={Size.FULL}
        label='图形验证码'
        name='captcha'
        autoComplete='off'
        maxLength={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        help='请输入图片里的字符，不区分大小写。看不清就点「换一张」。'
      />
      <div className='flex items-center gap-2'>
        {captcha.isPending ? (
          <span className='grid h-10 min-w-[7.5rem] place-items-center rounded-md border border-border bg-muted text-[12px] text-muted-foreground'>
            加载中…
          </span>
        ) : captcha.isError ? (
          <span className='grid h-10 min-w-[7.5rem] place-items-center rounded-md border border-destructive/40 bg-destructive/8 px-2 text-[11px] text-destructive'>
            验证码加载失败
          </span>
        ) : (
          <img
            src={toDataUri(captcha.data.image_base64)}
            alt='图形验证码'
            className='h-10 min-w-[7.5rem] rounded-md border border-border bg-muted object-contain'
          />
        )}
        <Button
          inline={false}
          aria-label='换一张验证码'
          onClick={() => {
            onChange('');
            setN((k) => k + 1);
          }}
        >
          换一张
        </Button>
      </div>
    </div>
  );
}

// 验证码是页面级的临时资源：不进 qk（它没有「失效」语义，只有「再要一张」）
function useCaptchaQuery(seed: number) {
  return useQuery({
    queryKey: ['captcha', seed],
    queryFn: ({ signal }) => fetchCaptcha(signal),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
}

function toDataUri(raw: string): string {
  return raw.startsWith('data:') ? raw : 'data:image/png;base64,' + raw;
}

function fieldError(e: unknown, key: string): string | undefined {
  return isApiError(e) ? e.fields?.[key] : undefined;
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  if (e.code === 'auth.bad_credentials') return '账号或密码错误。为保护账号，我们不会说明是哪一项不对。' + rid;
  if (e.code === 'auth.email_unverified') return '邮箱还没激活：登录后在提示里输入邮件里的 6 位验证码即可。' + rid;
  if (e.code === 'forum.sanctioned') return '账号正在禁言中，暂时不能发帖回复；浏览不受影响。' + rid;
  return e.message + rid;
}

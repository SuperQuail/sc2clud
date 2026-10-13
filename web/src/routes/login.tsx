import { useState, type FormEvent } from 'react';
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
  const next = params.get('next') ?? appPath('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [captcha, setCaptcha] = useState('');
  const [challenge, setChallenge] = useState(false);

  const signIn = useMutation({
    mutationFn: () => login({ username, password, captcha: captcha || undefined }),
    onSuccess: async () => {
      queryClient.clear(); // 上一个账号的缓存必须清掉（同一台设备换人登录）
      await queryClient.fetchQuery({ queryKey: qk.me(), queryFn: ({ signal }) => fetchMe(signal) });
      void navigate(next, { replace: true });
    },
    onError: (e) => {
      // 验证码错 / 需要验证码：后端用 auth.captcha_required / auth.captcha_wrong 表达（§21.4）
      if (isApiError(e) && (e.code === 'auth.captcha_required' || e.code === 'auth.captcha_wrong')) {
        setChallenge(true);
        setCaptcha('');
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
      footer={
        <>
          忘记密码：重置链路（POST /auth/password/forgot）还没接，见回报的端点清单；现在可以请管理员帮你重置。
          <br />
          <span className='inline-flex flex-wrap items-center gap-1'>
            账号被封了（或被驳回了帖子）？
            <a className='underline' href={appPath('appeal?type=ban')}>
              提交申诉
            </a>
            （不用登录，填用户名 + 注册邮箱 + 验证码）
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
        <FormAlert tone='error' title='验证码不对' description='请按图片重新输入一次；连续错误会触发限流。' />
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
        {/* 验证码按需出现：后端要才画（§21.4 的 auth.captcha_required），不是无条件挡一道 */}
        {challenge || isCaptchaError ? <ProductCaptcha value={captcha} onChange={setCaptcha} /> : null}
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
 */
export function ProductCaptcha({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const [seed, setSeed] = useState(0);
  const captcha = useCaptchaQuery(seed);
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
            setSeed((n) => n + 1);
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

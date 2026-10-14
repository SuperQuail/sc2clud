import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { CodeField } from '@/devroom/pages/16-auth/code-field';
import { ResendButton } from '@/devroom/pages/16-auth/resend-button';
import { useCountdown } from '@/devroom/pages/16-auth/use-countdown';
import { PasswordField } from '@/ui/password-field';
import { appPath } from '@/lib/url';
import { isApiError } from '@/lib/api/errors';
import { forgotPassword, resetPassword, verifyResetCode } from '@/lib/api/auth';

// 找回密码整页（G3）。**两步一页**（拍板 §11.7）：先确认邮箱，再用邮件里的 6 位码换票据、设新密码。
//
// 与 DevRoom `16-auth/forgot-view.tsx`（只读设计稿）的关系：那里是七种情形的展示台，走本地假状态；
// 这里是真页面，取的是同一批**房子件**（AuthShell / FormAlert / CodeField / ResendButton / PasswordField），
// 与登录页同一条路子（上线设计 P2 决策 2：同一份实现，不是两份）。
//
// 契约（forum/internal/auth/handler.go:43-45、114-121，字段名逐字照抄）：
//   POST /auth/password/forgot      { email }                 → 恒 200（不暴露邮箱是否存在）
//   POST /auth/password/verify-code { email, code }           → { reset_ticket }
//   POST /auth/password/reset       { reset_ticket, new_password } → 200（并删掉该用户全部会话）
// client 那三个函数已在 `lib/api/auth.ts`，这一步只做接线。
//
// 为什么两步在同一页：邮件里不发链接（拍板 §11），票据只在这一次交互里有意义；
// 分成两个路由就要把「邮箱」带过地址栏，那比现在多一个可伪造的输入。

type Step = 'request' | 'code' | 'done';

export function ForgotPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wrong, setWrong] = useState(false);
  const rate = useCountdown(0);
  const cooldown = useCountdown(0);
  const limited = rate.left > 0;

  /** 429 的 Retry-After（后端 auth.too_many_requests）——按服务端给的秒数起倒计时，不自己编一个。 */
  function noteRateLimit(e: unknown) {
    if (isApiError(e) && e.status === 429) {
      const sec = Math.ceil((e.retryAfterMs ?? 60_000) / 1000);
      rate.restart(sec);
      return true;
    }
    return false;
  }

  const sendCode = useMutation({
    mutationFn: () => forgotPassword(email.trim()),
    // 恒 200：无论邮箱存不存在都进第二步。这就是「不暴露账号是否存在」在界面上的落点。
    onSuccess: () => {
      setWrong(false);
      setCode('');
      setStep('code');
      cooldown.restart(60); // 后端 1 分钟只能发一次（keyMailIP），冷却不等服务端再拒一次
    },
    onError: noteRateLimit,
  });

  /**
   * 换票据 + 改密码**连着做完**：票据是一次性的（第二步 DELETE … RETURNING 消费它），
   * 中间留一次「请再点一下保存」只会让人以为第一次没生效。
   * 密码用参数从当前 state 传进来，不靠闭包读（避免拿到上一帧的值）。
   */
  const verify = useMutation({
    // reset_ticket 只活在这一次请求里：它是一次性的（服务端 DELETE … RETURNING 消费），
    // 存进 state 或地址栏都是把它交出去。
    mutationFn: async (next: string) => {
      const r = await verifyResetCode(email.trim(), code.trim());
      await resetPassword(r.reset_ticket, next);
    },
    onSuccess: () => setStep('done'),
    onError: (e) => {
      if (noteRateLimit(e)) return;
      // auth.token_invalid：**输错与过期同一句话**（后端 ErrTokenInvalid 只有一份文案）。
      // 这一条不是界面偷懒：分开说就等于给出「这个邮箱存在」的信号（设计 §11.4）。
      if (isApiError(e) && e.code === 'auth.token_invalid') setWrong(true);
    },
  });

  function submitRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    sendCode.mutate();
  }

  function submitReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    verify.mutate(password);
  }

  if (step === 'done') {
    return (
      <AuthShell title='密码已重置' subtitle='所有设备上的登录都已退出。' footer={FOOTER}>
        <FormAlert
          tone='success'
          title='请用新密码重新登录'
          description='为了安全，我们把你所有设备上的登录都退掉了；如果刚才是别人在操作，请立刻联系管理员。'
        />
        <div className='flex justify-end'>
          <Button primary inline={false} data-testid='forgot-go-login' onClick={() => void navigate(appPath('login'))}>
            去登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (step === 'request') {
    return (
      <AuthShell
        title='找回密码'
        subtitle='第 1 步 / 共 2 步：确认注册邮箱，我们把 6 位验证码发过去。'
        footer={FOOTER}
      >
        {limited ? (
          <FormAlert
            tone='error'
            title='请求太频繁'
            description={'这个页面每小时最多发 3 次，请在 ' + rate.left + ' 秒后再试。'}
          />
        ) : null}
        <form onSubmit={submitRequest} noValidate className='flex flex-col gap-3'>
          <Input
            size={Size.FULL}
            label='邮箱'
            type='email'
            name='email'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError(sendCode.error, 'email')}
            help='填注册时用的那个邮箱'
            autoComplete='email'
            placeholder='you@example.com'
            disabled={sendCode.isPending || limited}
          />
          <Button
            data-testid='forgot-send'
            type='submit'
            primary
            inline={false}
            className='w-full'
            disabled={sendCode.isPending || limited || email.trim() === ''}
            loader={sendCode.isPending}
          >
            发送验证码
          </Button>
        </form>
        <div className='flex justify-end text-[12px]'>
          <Button inline data-testid='forgot-back-login' onClick={() => void navigate(appPath('login'))}>
            返回登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  const mismatch = confirm !== '' && confirm !== password;
  return (
    <AuthShell
      title='输入验证码并设置新密码'
      subtitle={'第 2 步 / 共 2 步：验证码已发到 ' + email.trim() + '（10 分钟内有效）。'}
      footer={FOOTER}
    >
      {wrong ? (
        <FormAlert
          tone='error'
          title='验证码不正确或已过期'
          description='请重新输入，或者点「重新发送」拿一个新码。为安全起见，我们不会说明是输错了还是过期了。'
        />
      ) : null}
      {limited ? (
        <FormAlert
          tone='error'
          title='操作太频繁'
          description={'请在 ' + rate.left + ' 秒后再试。15 分钟内错误次数过多时也会这样拦一下。'}
        />
      ) : null}

      <form onSubmit={submitReset} noValidate className='flex flex-col gap-3'>
        {/* 错误态由上面那条 FormAlert 承载（后端对输错与过期只给一句话），这里不重复标红 */}
        <CodeField value={code} onChange={setCode} autoFocus help='邮箱里那 6 位数字，10 分钟内有效' />
        <PasswordField
          label='新密码'
          name='new-password'
          // 真页面必须给 autoComplete：密码管理器靠它认字段（房间里的设计稿刻意不传）
          autoComplete='new-password'
          value={password}
          onChange={setPassword}
          error={fieldError(verify.error, 'new_password')}
          help='8-128 位；不要和旧密码相同'
        />
        <PasswordField
          label='确认新密码'
          name='confirm-password'
          autoComplete='new-password'
          value={confirm}
          onChange={setConfirm}
          error={mismatch ? '两次输入不一致' : undefined}
          placeholder='再输一遍'
        />
        <Button
          data-testid='forgot-submit'
          type='submit'
          primary
          inline={false}
          className='w-full'
          disabled={verify.isPending || limited || code.trim().length !== 6 || password === '' || mismatch}
          loader={verify.isPending}
        >
          保存新密码
        </Button>
      </form>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[12px]'>
        <ResendButton
          seconds={cooldown.left}
          busy={sendCode.isPending}
          label='重新发送验证码'
          onSend={() => sendCode.mutate()}
        />
        <Button inline data-testid='forgot-change-email' onClick={() => setStep('request')}>
          换个邮箱
        </Button>
      </div>
    </AuthShell>
  );
}

/**
 * 页脚只说这一页真的能做的事。
 * **用 <a> 不用 Button**：AuthShell 把 footer 放进 <p>，而 <button> 在 <p> 里是非法嵌套
 * （登录页那两处是既有代码，不在我这次的作用域里）。
 */
const FOOTER = (
  <>
    想起密码了？
    <a className='ml-1 underline' href={appPath('login')}>
      返回登录
    </a>
  </>
);

function fieldError(e: unknown, key: string): string | undefined {
  return isApiError(e) ? e.fields?.[key] : undefined;
}

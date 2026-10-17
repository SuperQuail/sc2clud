import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from './auth-shell';
import { FormAlert } from './form-alert';
import { CodeField } from './code-field';
import { ResendButton } from './resend-button';
import { useCountdown } from './use-countdown';
import { COPY, MOCK_ACCOUNT, type AuthView, type VerifyScene } from './data';

// 「输入验证码」页（§11.2：只做验证码，不做链接）。
// 它是**注册成功后的落地页**，也是登录页情形 ④ 的出口。成功后**就地**变成「已激活，去登录」——
// 不再有「验证成功/链接失效」那种独立结果页，因为用户没有任何链接可点。
// 失败文案全站统一：「验证码不正确或已过期」。
export type VerifyViewProps = {
  scene: VerifyScene;
  onView: (view: AuthView) => void;
};

export function VerifyView({ scene, onView }: VerifyViewProps) {
  const [login, setLogin] = useState(MOCK_ACCOUNT.username);
  const [code, setCode] = useState(scene === 'activated' ? '482913' : '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const resend = useCountdown(scene === 'input' ? MOCK_ACCOUNT.resendCooldown : 0);
  const retry = useCountdown(scene === 'rateLimited' ? MOCK_ACCOUNT.retryAfter : 0);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    window.setTimeout(() => setBusy(false), 800);
  }

  if (scene === 'activated') {
    return (
      <AuthShell title='账号已激活' subtitle={'账号：' + MOCK_ACCOUNT.username} footer={COPY.codeFooter}>
        <FormAlert
          tone='success'
          title='验证码正确，邮箱已验证'
          description={'邮箱 ' + MOCK_ACCOUNT.email + ' 已验证。现在可以发帖、回复和上传了。'}
        />
        <div className='flex justify-end'>
          <Button primary inline={false} onClick={() => onView('login')}>
            去登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title='输入验证码'
      subtitle={'验证码已发到你的邮箱（10 分钟内有效）。没收到就重新发送，新码发出后旧码立刻失效。'}
      footer={COPY.codeFooter}
    >
      {scene === 'wrong' ? (
        <FormAlert
          tone='error'
          title='验证码不正确或已过期'
          description='请重新输入，或者点「重新发送」拿一个新码。为安全起见，我们不会说明是输错了还是过期了。'
        />
      ) : null}
      {scene === 'rateLimited' ? (
        <FormAlert
          tone='error'
          title='尝试次数过多'
          description={'我们在 15 分钟内收到了太多错误验证码，请等 ' + retry.left + ' 秒后再试，或重新发送一个新码。'}
        />
      ) : null}
      {sent ? (
        <FormAlert
          tone='info'
          title='新验证码已发出'
          description='旧码立刻失效了，请用最新那封邮件里的数字。1 分钟只能发一次。'
        />
      ) : null}

      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <Input
          size={Size.FULL}
          label='用户名或邮箱'
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          name='username'
          autoComplete='username'
          help='注册时填的那个'
        />
        <CodeField
          value={code}
          onChange={setCode}
          autoFocus
          help={'邮箱里那 6 位数字，' + MOCK_ACCOUNT.codeTtlMinutes + ' 分钟内有效'}
        />
        <Button type='submit' primary inline={false} disabled={busy || retry.left > 0} loader={busy} className='w-full'>
          激活账号
        </Button>
      </form>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[12px]'>
        <span className='text-muted-foreground'>没收到？</span>
        <ResendButton
          seconds={resend.left}
          busy={busy}
          onSend={() => {
            setSent(true);
            resend.restart(MOCK_ACCOUNT.resendCooldown);
          }}
        />
        <Button inline onClick={() => onView('login')}>
          稍后再激活，先去登录
        </Button>
      </div>
    </AuthShell>
  );
}

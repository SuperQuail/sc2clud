import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from './auth-shell';
import { FormAlert } from './form-alert';
import { CodeField } from './code-field';
import { PasswordField } from './password-field';
import { ResendButton } from './resend-button';
import { useCountdown } from './use-countdown';
import { COPY, MOCK_ACCOUNT, type AuthView, type ForgotScene } from './data';

// 找回密码：**两步一页**（§11.7）——输入验证码 → 设新密码。邮件里不再有链接。
// 第一步「填邮箱」仍然恒 200（不暴露邮箱是否注册过）；第二步的失败文案与激活页**同一句**，
// 否则「邮箱不存在」与「码错了」的差异就成了查账号的工具。
export type ForgotViewProps = {
  scene: ForgotScene;
  onScene: (scene: ForgotScene) => void;
  onView: (view: AuthView) => void;
};

export function ForgotView({ scene, onScene, onView }: ForgotViewProps) {
  const [email, setEmail] = useState(scene === 'request' ? '' : MOCK_ACCOUNT.email);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const resend = useCountdown(scene === 'code' ? MOCK_ACCOUNT.resendCooldown : 0);
  const retry = useCountdown(scene === 'rateLimited' ? MOCK_ACCOUNT.retryAfter : 0);

  function next(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    // 设计页：走一步就切到下一步，不真的发请求
    window.setTimeout(() => {
      setBusy(false);
      onScene('code');
    }, 700);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    window.setTimeout(() => setBusy(false), 800);
  }

  if (scene === 'done') {
    return (
      <AuthShell title='密码已重置' subtitle='所有设备上的登录都已退出。' footer={COPY.forgotFooter}>
        <FormAlert
          tone='success'
          title='请用新密码重新登录'
          description='为了安全，我们把你所有设备上的登录都退掉了；如果刚才是别人在操作，请立刻联系管理员。'
        />
        <div className='flex justify-end'>
          <Button primary inline={false} onClick={() => onView('login')}>
            去登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (scene === 'request') {
    return (
      <AuthShell
        title='找回密码'
        subtitle='第 1 步 / 共 2 步：确认注册邮箱，我们把 6 位验证码发过去。'
        footer={COPY.forgotFooter}
      >
        {retry.left > 0 ? (
          <FormAlert
            tone='error'
            title='请求太频繁'
            description={'这个页面每小时最多发 3 次，请在 ' + retry.left + ' 秒后再试。'}
          />
        ) : null}
        <form onSubmit={next} noValidate className='flex flex-col gap-3'>
          <Input
            label='邮箱'
            type='email'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            help='填注册时用的那个邮箱'
            name='email'
            autoComplete='email'
            disabled={busy || retry.left > 0}
            placeholder='you@example.com'
          />
          <Button type='submit' primary inline={false} disabled={busy || retry.left > 0} loader={busy} className='w-full'>
            {retry.left > 0 ? '发送验证码（' + retry.left + ' 秒后可再试）' : '发送验证码'}
          </Button>
        </form>
        <div className='flex justify-end text-[12px]'>
          <Button inline onClick={() => onView('login')}>
            返回登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title='输入验证码并设置新密码'
      subtitle={'第 2 步 / 共 2 步：验证码已发到 ' + MOCK_ACCOUNT.email + '（10 分钟内有效）。'}
      footer={COPY.forgotFooter}
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
          title='操作太频繁'
          description={'请在 ' + retry.left + ' 秒后再试。15 分钟内错误次数过多时也会这样拦一下。'}
        />
      ) : null}
      {sent ? (
        <FormAlert tone='info' title='新验证码已发出' description='旧码立刻失效了，请用最新那封邮件里的数字。1 分钟只能发一次。' />
      ) : null}

      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <CodeField
          value={code}
          onChange={setCode}
          autoFocus
          help={'邮箱里那 6 位数字，' + MOCK_ACCOUNT.codeTtlMinutes + ' 分钟内有效'}
        />
        <PasswordField
          label='新密码'
          value={password}
          onChange={setPassword}
          help='8-128 位；不要和旧密码相同'
          name='new-password'
          autoComplete='new-password'
        />
        <PasswordField
          label='确认新密码'
          value={confirm}
          onChange={setConfirm}
          name='confirm-password'
          autoComplete='new-password'
          placeholder='再输一遍'
        />
        <Button type='submit' primary inline={false} disabled={busy || retry.left > 0} loader={busy} className='w-full'>
          保存新密码
        </Button>
      </form>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[12px]'>
        <ResendButton
          seconds={resend.left}
          busy={busy}
          label='重新发送验证码'
          onSend={() => {
            setSent(true);
            resend.restart(MOCK_ACCOUNT.resendCooldown);
          }}
        />
        <Button inline onClick={() => onScene('request')}>
          换个邮箱
        </Button>
      </div>
    </AuthShell>
  );
}

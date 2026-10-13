import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { AuthShell } from './auth-shell';
import { FormAlert } from './form-alert';
import { PasswordField } from './password-field';
import { CaptchaField } from './captcha-field';
import { ResendButton } from './resend-button';
import { useCountdown } from './use-countdown';
import { CAPTCHA_SAMPLES, COPY, MOCK_ACCOUNT, nextCaptcha, type AuthView, type LoginScene } from './data';

// 登录视图：一张表单，**七种情形只是它的七个状态**（拍板 §9.6 那张表）。
// 关键的业务判断写在代码里而不是文案里：未激活**允许登录**（能读、能重发），不要在登录时拦死。
export type LoginViewProps = {
  scene: LoginScene;
  onScene: (scene: LoginScene) => void;
  onView: (view: AuthView) => void;
};

export function LoginView({ scene, onScene, onView }: LoginViewProps) {
  const [username, setUsername] = useState(MOCK_ACCOUNT.username);
  const [password, setPassword] = useState('demo-password-123');
  const [remember, setRemember] = useState(true);
  const [captcha, setCaptcha] = useState('');
  const [chars, setChars] = useState(CAPTCHA_SAMPLES[0]!);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 未激活：登录后提示查收邮件，重发按钮自带 60 秒冷却（后端 1 分钟 1 次）
  const resend = useCountdown(scene === 'pendingEmail' ? MOCK_ACCOUNT.resendCooldown : 0);
  // 限流：429 带 Retry-After，倒计时期间按钮禁用
  const retry = useCountdown(scene === 'rateLimited' ? MOCK_ACCOUNT.retryAfter : 0);
  // 情形 ⑤ 里点「重新发送」成功后，就地变成情形 ④ 的样子（拍板 §9.2：从 manual 也能回到 email）
  const [manualResent, setManualResent] = useState(false);

  const locked = retry.left > 0;
  const pending = scene === 'pendingEmail' || (scene === 'pendingManual' && !manualResent);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (scene === 'captcha' && captcha.trim() === '') {
      setCaptchaError('请输入图片中的验证码');
      return;
    }
    // 设计页：只演示「提交中禁用 + 进度」，不真的发请求
    setBusy(true);
    window.setTimeout(() => setBusy(false), 900);
  }

  if (pending) {
    const manual = scene === 'pendingManual';
    return (
      <AuthShell title='登录成功' subtitle={'账号：' + MOCK_ACCOUNT.username + '（未激活）'} footer={COPY.loginFooter}>
        {manual ? (
          <FormAlert
            tone='warning'
            title='邮件暂时发不出去，已通知管理员帮你激活'
            description='你也可以稍后再点一次重新发送；管理员激活后就能发帖了。这段时间浏览、收藏都不受影响。'
          >
            <div className='mt-2'>
              <ResendButton
                seconds={resend.left}
                label='重新发送验证码'
                onSend={() => {
                  setManualResent(true);
                  resend.restart(MOCK_ACCOUNT.resendCooldown);
                }}
              />
            </div>
          </FormAlert>
        ) : (
          <FormAlert
            tone='warning'
            title='账号还没激活，验证码已发到你的邮箱'
            description={'收件邮箱 ' + MOCK_ACCOUNT.email + '：输入邮件里的 6 位数字就能激活（10 分钟内有效）。没收到可以再发一次（1 分钟只能发一次）。'}
          >
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Button primary inline={false} onClick={() => onView('verify')}>
                去输入验证码
              </Button>
              <ResendButton
                seconds={resend.left}
                busy={busy}
                label='重新发送'
                onSend={() => {
                  setBusy(true);
                  window.setTimeout(() => {
                    setBusy(false);
                    resend.restart(MOCK_ACCOUNT.resendCooldown);
                  }, 700);
                }}
              />
            </div>
          </FormAlert>
        )}
        <FormAlert
          tone='info'
          title='未激活也能正常浏览'
          description='只是发帖、回复、上传会被拦下并提示「需要先激活」；邮箱验证不是门槛，激活才是。'
        />
        <div className='flex justify-end'>
          <Button inline onClick={() => onScene('ok')}>
            用别的账号登录
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title='登录 SC2clud' subtitle='用社区账号继续，或先注册一个。' footer={COPY.loginFooter}>
      {scene === 'badCredentials' ? (
        <FormAlert
          tone='error'
          title='账号或密码错误'
          description='请检查用户名与密码后重试。为保护账号，我们不会说明是哪一项不对。'
        />
      ) : null}
      {scene === 'banned' ? (
        <FormAlert
          tone='error'
          title='账号已被封禁'
          description='被封禁的账号不能登录。如需申诉，请在社区里联系管理员（可先用其它账号发帖求助）。'
        />
      ) : null}
      {scene === 'rateLimited' ? (
        <FormAlert
          tone='error'
          title='尝试次数过多'
          description={'请等 ' + retry.left + ' 秒后再试。这期间你可以先去重置密码——重置不受这个限制。'}
        />
      ) : null}

      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <Input
          size={Size.FULL}
          label='用户名或邮箱'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          name='username'
          autoComplete='username'
          disabled={busy}
          placeholder='用户名或注册邮箱'
        />
        <PasswordField
          label='密码'
          value={password}
          onChange={setPassword}
          name='password'
          autoComplete='current-password'
        />
        {scene === 'captcha' ? (
          <CaptchaField
            chars={chars}
            value={captcha}
            onChange={(v) => {
              setCaptcha(v);
              setCaptchaError(null);
            }}
            onRefresh={() => setChars(nextCaptcha(chars))}
            error={captchaError}
          />
        ) : null}
        <Checkbox label='记住我（这台设备 7 天免登录）' checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <Button
          type='submit'
          primary
          inline={false}
          disabled={busy || locked}
          loader={busy}
          className='w-full'
        >
          {locked ? '登录（' + retry.left + ' 秒后可再试）' : '登录'}
        </Button>
      </form>

      <div className='flex flex-wrap items-center justify-between gap-2 text-[12px]'>
        <Button inline onClick={() => onView('forgot')}>
          忘记密码？
        </Button>
        <span className='text-muted-foreground'>
          还没有账号？
          <Button inline onClick={() => onView('register')}>
            注册
          </Button>
        </span>
      </div>
    </AuthShell>
  );
}

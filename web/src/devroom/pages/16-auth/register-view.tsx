import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from './auth-shell';
import { FormAlert } from './form-alert';
import { PasswordField } from './password-field';
import { CaptchaField } from './captcha-field';
import { CAPTCHA_SAMPLES, COPY, MOCK_ACCOUNT, nextCaptcha, type AuthView, type RegisterScene } from './data';

// 注册视图。三条规矩写死在界面上：
//   ① 用户名注册后不可改（help 文案里说清楚）；② 注册**不自动登录**（201 只回 id/handle/email_verified）；
//   ③ 注册成功后**直接落到「输入验证码」页**（§11.2：邮件里是 6 位码，不是链接），所以这里没有「去看邮件」的独立结果页。
export type RegisterViewProps = {
  scene: RegisterScene;
  onView: (view: AuthView) => void;
};

/** 服务端 error.fields 的形状：字段名 → 文案，直接喂给对应 Input 的 error */
const FIELD_ERRORS: Record<string, string> = {
  username: '这个用户名已经被占用了，换一个试试',
  email: '这个邮箱已经注册过了，可以直接登录或找回密码',
};

export function RegisterView({ scene, onView }: RegisterViewProps) {
  const [username, setUsername] = useState(scene === 'fieldErrors' ? 'tangtian' : '');
  const [email, setEmail] = useState(scene === 'fieldErrors' ? MOCK_ACCOUNT.email : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [chars, setChars] = useState(CAPTCHA_SAMPLES[1]!);
  const [busy, setBusy] = useState(false);
  const err = (field: string) => (scene === 'fieldErrors' ? FIELD_ERRORS[field] : null);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    // 设计页：注册成功后直接切到「输入验证码」页，这就是真实流程的落地页
    window.setTimeout(() => {
      setBusy(false);
      onView('verify');
    }, 800);
  }

  return (
    <AuthShell
      title='注册 SC2clud'
      subtitle='注册后需要激活才能发帖：我们会把 6 位验证码发到你的邮箱，输入后即可激活。'
      footer={COPY.registerFooter}
    >
      {scene === 'fieldErrors' ? (
        <FormAlert
          tone='error'
          title='这两个信息已经有人用了'
          description='用户名和邮箱都必须唯一。邮箱若已注册，可以直接登录或找回密码。'
        />
      ) : null}
      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <Input
          label='用户名'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={err('username')}
          help='3-24 位，字母、数字、下划线或短横线；注册后不可修改'
          name='username'
          autoComplete='username'
          placeholder='例如 sc2-player'
        />
        <Input
          label='邮箱'
          type='email'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={err('email')}
          help='用来收激活验证码和重置密码'
          name='email'
          autoComplete='email'
          placeholder='you@example.com'
        />
        <PasswordField
          label='密码'
          value={password}
          onChange={setPassword}
          help='8-128 位，别用其它站点用过的密码'
          name='new-password'
          autoComplete='new-password'
        />
        <PasswordField
          label='确认密码'
          value={confirm}
          onChange={setConfirm}
          name='confirm-password'
          autoComplete='new-password'
          placeholder='再输一遍'
        />
        <CaptchaField chars={chars} value={captcha} onChange={setCaptcha} onRefresh={() => setChars(nextCaptcha(chars))} />
        <Button type='submit' primary inline={false} disabled={busy} loader={busy} className='w-full'>
          注册
        </Button>
      </form>
      <div className='flex justify-end text-[12px]'>
        <span className='text-muted-foreground'>
          已经有账号了？
          <Button inline onClick={() => onView('login')}>
            登录
          </Button>
        </span>
      </div>
    </AuthShell>
  );
}

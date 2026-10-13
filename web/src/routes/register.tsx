import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { PasswordField } from '@/ui/password-field';
import { appPath } from '@/lib/url';
import { isApiError } from '@/lib/api/errors';
import { register } from '@/lib/api/auth';
import { ProductCaptcha } from './login';

// 注册页（契约：POST /auth/register → 201，发验证邮件）。
// 注册成功后落「输入验证码」页（后端开工前拍板 §11：邮箱激活走 6 位验证码，不发链接），
// 所以这一页只负责建账号并把单号（邮箱）带到下一页 —— 不在这里假激活。
const HANDLE_MAX = 24;
const NICK_MAX = 32;

export function RegisterPage() {
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => register({ username: handle, email, password, captcha: captcha || undefined }),
    onSuccess: () => void navigate(appPath('register/verify?email=' + encodeURIComponent(email)), { replace: true }),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password !== confirm) {
      setLocalError('两次输入的密码不一致');
      return;
    }
    setLocalError(null);
    submit.mutate();
  }

  const err = submit.error;

  return (
    <AuthShell
      title='注册 SC2clud'
      subtitle='一个昵称就能开始：注册后可以立刻浏览、收藏；发帖与上传要等邮箱激活。'
      footer={
        <>
          注册即表示同意站点规则。已有的账号？
          <a className='underline' href={appPath('login')}>
            直接登录
          </a>
        </>
      }
    >
      {localError ? <FormAlert tone='error' title='还不能提交' description={localError} /> : null}
      {err ? <FormAlert tone='error' title='没能注册' description={errorText(err)} /> : null}

      <form onSubmit={onSubmit} noValidate className='flex flex-col gap-3'>
        <Input
          size={Size.FULL}
          label='用户名（登录名）'
          name='username'
          autoComplete='username'
          maxLength={HANDLE_MAX}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          error={fieldError(err, 'username')}
          help={'最多 ' + HANDLE_MAX + ' 字，字母数字与下划线。注册后不可修改，别人 @ 你用的就是它。'}
          placeholder='marine'
        />
        <Input
          size={Size.FULL}
          label='昵称（显示名）'
          name='nickname'
          autoComplete='nickname'
          maxLength={NICK_MAX}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          error={fieldError(err, 'nickname')}
          help='昵称与用户名暂时用同一个值（PATCH /me 可以之后再改）。'
        />
        <Input
          size={Size.FULL}
          type='email'
          label='邮箱'
          name='email'
          autoComplete='email'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError(err, 'email')}
          help='激活码发到这里。它不会公开，只用来找回账号与收答复。'
          placeholder='you@example.com'
        />
        <PasswordField
          label='密码'
          name='password'
          autoComplete='new-password'
          value={password}
          onChange={setPassword}
          error={fieldError(err, 'password')}
          help='至少 8 位；不要与别的站点相同。'
        />
        <PasswordField
          label='再输一次密码'
          name='password_confirm'
          autoComplete='new-password'
          value={confirm}
          onChange={setConfirm}
        />
        <ProductCaptcha value={captcha} onChange={setCaptcha} error={fieldError(err, 'captcha')} />
        <Button
          data-testid='register-submit'
          type='submit'
          primary
          inline={false}
          className='w-full'
          disabled={submit.isPending || handle === '' || email === '' || password === ''}
          loader={submit.isPending}
        >
          注册
        </Button>
      </form>

      <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
        注册后如果没收到激活邮件，可以在登录后让页面重发一次（POST /auth/email/resend，1 分钟 1 次）。
      </p>
    </AuthShell>
  );
}

function fieldError(e: unknown, key: string): string | undefined {
  return isApiError(e) ? e.fields?.[key] : undefined;
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  if (e.status === 409 || e.code === 'common.conflict') return '这个用户名或邮箱已经被注册过了。' + rid;
  if (e.code === 'auth.captcha_wrong' || e.code === 'auth.captcha_required') return '图形验证码不对，请重新输入。' + rid;
  if (e.status === 429) return '提交太频繁了，等一会儿再试。' + rid;
  return e.message + rid;
}

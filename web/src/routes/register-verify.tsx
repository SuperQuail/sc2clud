import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath, routePath } from '@/lib/url';
import { isApiError } from '@/lib/api/errors';
import { resendVerification, verifyEmail } from '@/lib/api/auth';

// 邮箱激活（契约：POST /auth/email/verify { token }、POST /auth/email/resend）。
// 激活走 **6 位验证码**而不是链接（后端开工前拍板 §11）：换设备也能激活，链接不会被邮件网关吃掉。
// 未激活**允许登录**（能读、能重发），所以这一页不是拦路虎，只是「补一道手续」的地方。
export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const email = params.get('email') ?? '';
  const [code, setCode] = useState('');

  const submit = useMutation({
    mutationFn: () => verifyEmail(code.trim()),
    onSuccess: () => void navigate(routePath('login'), { replace: true }),
  });
  const resend = useMutation({ mutationFn: () => resendVerification() });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit.mutate();
  }

  return (
    <AuthShell
      title='输入验证码'
      subtitle={email ? '激活码已发到 ' + email + '，10 分钟内有效。' : '激活码已发到你的注册邮箱，10 分钟内有效。'}
      footer={
        <>
          激活前可以照常浏览、收藏与下载；发帖、回复、上传会被拦下并提示「需要先激活」。
          <br />
          <a className='underline' href={appPath('login')}>
            先去登录
          </a>
        </>
      }
    >
      {submit.isError ? <FormAlert tone='error' title='激活失败' description={errorText(submit.error)} /> : null}
      {resend.isSuccess ? (
        <FormAlert tone='success' title='已重新发送' description='1 分钟只能发一次；没收到就检查垃圾邮件箱。' />
      ) : null}
      {resend.isError ? <FormAlert tone='error' title='发送失败' description={errorText(resend.error)} /> : null}

      <form onSubmit={onSubmit} noValidate className='flex flex-col gap-3'>
        <Input
          size={Size.FULL}
          label='6 位验证码'
          name='token'
          autoComplete='one-time-code'
          inputMode='numeric'
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          error={isApiError(submit.error) ? submit.error.fields?.['token'] : undefined}
          help='邮件里那 6 个数字，不含空格。'
          placeholder='123456'
        />
        <Button
          data-testid='verify-submit'
          type='submit'
          primary
          inline={false}
          className='w-full'
          disabled={submit.isPending || code.length !== 6}
          loader={submit.isPending}
        >
          激活账号
        </Button>
      </form>

      <Button inline loader={resend.isPending} disabled={resend.isPending} onClick={() => resend.mutate()}>
        没收到？重新发送
      </Button>
    </AuthShell>
  );
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  if (e.code === 'auth.token_invalid') return '验证码不对或已过期。可以让页面再发一次。' + rid;
  if (e.status === 429) return '发送太频繁了（1 分钟 1 次、每天 5 次）。' + rid;
  return e.message + rid;
}

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

// 邮箱激活（契约：POST /auth/email/verify { username|email, code }、POST /auth/email/resend）。
// 激活走 **6 位验证码**而不是链接（后端开工前拍板 §11）：换设备也能激活，链接不会被邮件网关吃掉。
// 未激活**允许登录**（能读），所以这一页不是拦路虎，只是「补一道手续」的地方。
//
// 2026-10-14 修（原先是坏的）：这一页只收验证码、发的是 `{ token }`，而真源是
// verifyCodeReq{ username|email, code }（auth/handler.go:88-106）—— 激活请求 100% 被 400 拒掉，
// 页面还把它显示成「验证码不对」。现在补上「用户名或邮箱」这一格（DevRoom 16-auth 的 verify-view 本来就有）。
export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const email = params.get('email') ?? '';
  // 注册页会把邮箱带过来；用户也可以改填用户名（两条路后端都认）
  const [who, setWho] = useState(email);
  const [code, setCode] = useState('');

  const submit = useMutation({
    mutationFn: () => verifyEmail(who, code.trim()),
    onSuccess: () => void navigate(routePath('login'), { replace: true }),
  });
  // 重发要已登录（服务端从会话取人）：注册不建会话，所以这里登录前多半会 401 —— 文案里说实话。
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
          label='用户名或邮箱'
          name='username'
          autoComplete='username'
          value={who}
          onChange={(e) => setWho(e.target.value)}
          error={isApiError(submit.error) ? submit.error.fields?.['username'] : undefined}
          help='注册时用的那一个，填哪个都行。'
        />
        <Input
          size={Size.FULL}
          label='6 位验证码'
          name='token'
          autoComplete='one-time-code'
          inputMode='numeric'
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          error={isApiError(submit.error) ? submit.error.fields?.['code'] : undefined}
          help='邮件里那 6 个数字，不含空格。'
          placeholder='123456'
        />
        <Button
          data-testid='verify-submit'
          type='submit'
          primary
          inline={false}
          className='w-full'
          disabled={submit.isPending || code.length !== 6 || who.trim() === ''}
          loader={submit.isPending}
        >
          激活账号
        </Button>
      </form>

      {/* 重发接口挂在 RequireLogin 下：未登录时它会 401，与其让人以为是坏了，不如先说是登录后才行 */}
      <Button
        inline
        loader={resend.isPending}
        disabled={resend.isPending}
        title='重发需要先登录（后端从会话取收件人）'
        onClick={() => resend.mutate()}
      >
        没收到？重新发送（需先登录）
      </Button>
    </AuthShell>
  );
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  const rid = e.requestId ? '（错误编号 ' + e.requestId + '）' : '';
  if (e.code === 'auth.token_invalid') return '验证码不正确或已过期。登录后可以让页面再发一次。' + rid;
  if (e.status === 429) return '发送太频繁了（1 分钟 1 次、每天 5 次）。' + rid;
  return e.message + rid;
}

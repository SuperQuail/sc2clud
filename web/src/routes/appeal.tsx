import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath } from '@/lib/url';
import { apiErrorLine, apiErrorLineWith, isApiError } from '@/lib/api/errors';
import { api } from '@/lib/api/client';
import { useSession } from '@/lib/perms';
import { ProductCaptcha } from './login';

// 申诉 / 反馈（**免登录**：被封的人登不进来，登录页那句「联系管理员」对他是死路 —— 盲审合并结论 §7）。
// 事由与要填的字段照 DevRoom 17-appeal 的设计（四种事由、一条链路），但**不搬它的演示控制台**。
//
// ⚠️ 契约缺口（见回报的端点清单）：这一条链路的端点在 v2 §21.2 **不存在** ——
// §21.2 只有「帖子的作者申诉」POST /api/v1/topics/{id}/review/appeal（登录 + 仅作者，拍板 §10.10-1）。
// 被封者的申诉（用户名 + 邮箱 + 验证码自证）需要 P1 定一个免登录端点，这里按最自然的形状送：
//   POST /api/v1/appeals { type, username, email, ref?, title, details, contact?, captcha? }
//   captcha_id 还没接：appeals 端点本身还没实现（见页脚的端点清单），
//   现在补一个没人消费的字段只会在后端真做的时候变成第二个真源。
//   → 202 { no, eta }（单号 + 答复时限；事由非法 / 限流分别 400 / 429 appeal.rate_limited）
// 端点落地前，提交会走到 404 —— 页面会**如实**说「申诉通道还没通，请用邮件联系管理员」，不会假装收到了。
const APPEAL_ENDPOINT = 'appeals';

const TYPES = [
  { key: 'ban', label: '账号封禁申诉' },
  { key: 'review_reject', label: '帖子审核被驳回' },
  { key: 'report_result', label: '举报处理结果有异议' },
  { key: 'other', label: '其它反馈' },
] as const;

type AppealType = (typeof TYPES)[number]['key'];

const NEED_LOGIN: AppealType[] = ['review_reject'];

export function AppealPage() {
  const [params] = useSearchParams();
  const session = useSession();
  const [type, setType] = useState<AppealType>(() => {
    const raw = params.get('type') ?? 'ban';
    return (TYPES.find((t) => t.key === raw)?.key ?? 'ban') as AppealType;
  });
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [ref, setRef] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [captcha, setCaptcha] = useState('');
  // 图形验证码是**成对**校验的：服务端按 id 找答案（无论对错都作废那张图）。
  // 只发答案的话后端拿不到题 → 一律 auth.captcha_wrong，用户会以为是自己看错了图。
  const [captchaId, setCaptchaId] = useState('');
  const [touched, setTouched] = useState(false);

  const loggedIn = session.isLoggedIn;
  const loginFirst = !loggedIn && NEED_LOGIN.includes(type);

  const submit = useMutation({
    mutationFn: () =>
      api<{ no: string; eta?: string }>(APPEAL_ENDPOINT, {
        method: 'POST',
        body: {
          type, username, email, ref: ref || undefined, title, details,
          contact: contact || undefined,
          captcha: captcha || undefined, captcha_id: captchaId || undefined,
        },
      }),
    onSuccess: () => window.scrollTo({ top: 0 }),
  });

  const missing = [
    !loggedIn && username.trim() === '' ? '用户名' : null,
    !loggedIn && email.trim() === '' ? '注册邮箱' : null,
    title.trim() === '' ? '标题' : null,
    details.trim() === '' ? '详细说明' : null,
    !loggedIn && captcha.trim() === '' ? '图形验证码' : null,
  ].filter((x): x is string => x !== null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (missing.length > 0) return;
    submit.mutate();
  }

  if (submit.isSuccess) {
    return (
      <AuthShell
        title='已经收到你的申诉'
        subtitle='它不会静默消失：无论维持还是解封，都会给你一条答复。'
        footer={
          <>
            答复会发到上面填的注册邮箱。
            <br />
            <a className='underline' href={appPath('login')}>
              回登录页
            </a>
          </>
        }
      >
        <FormAlert
          tone='success'
          title={'申诉单号 ' + (submit.data.no ?? '（后端未返回单号）')}
          description={
            submit.data.eta
              ? submit.data.eta + '内答复。记下单号，写信询问时引用它最快。'
              : '答复时限由后端定；单号请记下，写信询问时引用它最快。'
          }
        />
        <Button inline={false} onClick={() => submit.reset()}>
          再提交一条
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title='申诉 / 反馈'
      subtitle='不需要登录：被封禁的账号登不进来、也发不了帖，所以这条链路专门给「进不来的人」留了一条路。'
      footer={
        <>
          填用户名 + 注册邮箱 + 图形验证码即可提交；我们按这三样核对身份。
          <br />
          已经能登录？帖子被驳回这类事由请直接登录后提交（后端只认作者本人）。
        </>
      }
    >
      {loginFirst ? (
        <FormAlert
          tone='warning'
          title='这一种事由需要先登录'
          description='帖子审核被驳回只有作者本人能申诉，未登录时我们无法证明「你就是作者」。封禁申诉不需要登录。'
        >
          <span className='mt-2 flex flex-wrap items-center gap-2'>
            <Button primary inline={false} href={appPath('login')}>
              去登录
            </Button>
            <Button onClick={() => setType('ban')}>改投封禁申诉（不用登录）</Button>
          </span>
        </FormAlert>
      ) : null}

      {submit.isError ? (
        <FormAlert
          tone='error'
          title={isApiError(submit.error) && submit.error.status === 404 ? '申诉通道还没通' : '没能提交'}
          description={errorText(submit.error)}
        />
      ) : null}
      {touched && missing.length > 0 ? (
        <FormAlert
          tone='warning'
          title={'还有 ' + missing.length + ' 项没填好'}
          description='下面标红的就是要改的地方。填完再点一次提交即可，已经填好的内容不会丢。'
        />
      ) : null}

      <form onSubmit={onSubmit} noValidate className='flex flex-col gap-3'>
        <Select
          type={SelectType.INPUT}
          label='事由'
          size={Size.FULL}
          data={TYPES.map((t) => ({ key: t.key, label: t.label }))}
          selected={TYPES.filter((t) => t.key === type).map((t) => ({ key: t.key, label: t.label }))[0] ?? null}
          onSelect={(item) => {
            if (item) setType(String(item.key) as AppealType);
          }}
          disabled={submit.isPending}
        />

        {!loggedIn ? (
          <>
            <Input
              size={Size.FULL}
              label='用户名或邮箱'
              name='appeal_user'
              autoComplete='off'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              error={touched && username.trim() === '' ? '用户名是必填的' : undefined}
              help='被封 / 出问题的那个账号。'
              disabled={submit.isPending}
            />
            <Input
              size={Size.FULL}
              label='注册邮箱'
              name='appeal_email'
              autoComplete='off'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={touched && email.trim() === '' ? '注册邮箱是必填的' : undefined}
              help='答复发到这里，必须与账号注册邮箱一致 —— 它就是这条申诉的身份凭证。'
              disabled={submit.isPending}
            />
          </>
        ) : (
          <FormAlert
            tone='info'
            title='身份已确认（登录态）'
            description={'账号 ' + (session.session?.nickname ?? '') + ' · @' + (session.session?.handle ?? '') + '，不需要再证明一次。'}
          />
        )}

        <Input
          size={Size.FULL}
          label='涉及的地方（可选）'
          name='appeal_ref'
          autoComplete='off'
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          help='封禁时间、被驳回的帖子标题或链接、你举报过的那条内容。'
          disabled={submit.isPending}
        />
        <Input
          size={Size.FULL}
          label='标题'
          name='appeal_title'
          autoComplete='off'
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={touched && title.trim() === '' ? '标题是必填的' : undefined}
          help='写清是哪件事：像「请复查 10-12 的封禁」比「求解封」有用得多。'
          disabled={submit.isPending}
        />
        <Input
          size={Size.FULL}
          multiline
          rows={5}
          inputClassName='!h-[128px]'
          label='详细说明'
          name='appeal_details'
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          error={touched && details.trim() === '' ? '详细说明是必填的' : undefined}
          help='把时间、经过、你希望的结果写全，可以分段。'
          disabled={submit.isPending}
        />
        <Input
          size={Size.FULL}
          label='其它联系方式（可选）'
          name='appeal_contact'
          autoComplete='off'
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          help='只在邮箱联系不上你时用，不会公开。'
          disabled={submit.isPending}
        />

        {!loggedIn ? <ProductCaptcha value={captcha} onChange={setCaptcha} onChallenge={setCaptchaId} /> : null}

        <Button
          data-testid='appeal-submit'
          type='submit'
          primary
          inline={false}
          className='w-full'
          disabled={submit.isPending || loginFirst}
          loader={submit.isPending}
        >
          {submit.isPending ? '提交中…' : type === 'other' ? '提交反馈' : '提交申诉'}
        </Button>
        <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
          提交后立刻给你单号与答复时间（不会静默）。证明材料的上传通道还没接 ——
          先把要说明的事写进「详细说明」，别把关键信息留在一个传不上去的附件里。
        </p>
      </form>
    </AuthShell>
  );
}

function errorText(e: unknown): string {
  if (!isApiError(e)) return String(e);
  if (e.status === 404) {
    return apiErrorLineWith(
      e,
      '后端还没有这条免登录申诉的端点（见回报的端点清单：POST /api/v1/appeals）。' +
        '在这之前，请用站点公告里的管理员邮箱联系我们 —— 这次提交没有被记录。',
    );
  }
  if (e.status === 429) return apiErrorLineWith(e, '同一个账号/IP 24 小时最多提交 3 条，请明天再试。');
  if (e.code === 'auth.captcha_wrong') return apiErrorLineWith(e, '图形验证码不对，请重新输入。');
  return apiErrorLine(e);
}

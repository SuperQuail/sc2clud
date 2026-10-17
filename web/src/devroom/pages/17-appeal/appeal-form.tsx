import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { CircleHelp, Paperclip, ShieldCheck } from 'lucide-react';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { CaptchaField } from '@/devroom/pages/16-auth/captcha-field';
import { CAPTCHA_SAMPLES, nextCaptcha } from '@/devroom/pages/16-auth/data';
import { roomHref, protoTitle } from '@/devroom/room-links';
import {
  APPEAL_TYPES,
  FIELD,
  MOCK_GUEST,
  requiredKeys,
  type AppealType,
  type FieldKey,
} from './data';

// 申诉 / 反馈表单：**一个页面、多种事由、一条提交链路**。
// 事由之间的差别全在 data.ts 的 APPEAL_TYPES 里（文案、必填项、成功文案），这里不写 if (type === ...)。
//
// 两条身份路（本页存在的理由就是第二条）：
//   ① 已登录：身份字段自动带出、只读；
//   ② 未登录：被封的人登不进来，所以用 用户名 + 注册邮箱 + **图形验证码** 自证
//      （验证码控件直接复用 16-auth 的 CaptchaField，不新造）。
/** Select 的条目形状（key/label）由 APPEAL_TYPES 一次性派生：库要的对象不等于页面配置 */
const TYPE_ITEMS = APPEAL_TYPES.map((t) => ({ key: t.type, label: t.label }));

export type AppealFormProps = {
  actor: 'guest' | 'self';
  /** 已登录时带出的账号（设计稿里是假的） */
  account: { username: string; email: string };
  /** 类型初值来自 ?type= */
  type: AppealType;
  onType: (t: AppealType) => void;
  /** 服务端字段错误（真实现来自 error.fields）；演示时由外部按下 */
  fieldErrors?: Partial<Record<FieldKey, string>>;
  /** 非字段类错误（429 / 网络） */
  submitError?: string | null;
  pending: boolean;
  /** 提交：单号由外部发（真实现由后端返回 202 + 单号） */
  onSubmit: (v: { type: AppealType; title: string }) => void;
};

export function AppealForm({ actor, account, type, onType, fieldErrors, submitError, pending, onSubmit }: AppealFormProps) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [ref, setRef] = useState('');
  const [who, setWho] = useState('');
  const [email, setEmail] = useState('');
  const [proof, setProof] = useState('');
  const [contact, setContact] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [chars, setChars] = useState(CAPTCHA_SAMPLES[0]!);
  const [attach, setAttach] = useState(false);
  /** 只在按过提交之后才飘红：没填完就红一片是最惹人烦的表单行为 */
  const [touched, setTouched] = useState(false);

  const cfg = APPEAL_TYPES.find((t) => t.type === type)!;
  const guest = actor === 'guest';
  const need = requiredKeys(cfg, actor);
  const valueOf: Record<FieldKey, string> = {
    type,
    actor,
    ref,
    email,
    proof,
    title,
    details,
    contact,
    captcha,
    evidence: attach ? '1' : '',
  };

  const simpleKeys = ['actor', 'email', 'proof', 'title', 'details', 'contact', 'captcha'] as const;
  const labelOf = (k: FieldKey): string =>
    k === 'ref' ? cfg.ref.label : FIELD[simpleKeys.find((s) => s === k)!].label;
  const blanks = need.filter((k) => valueOf[k].trim() === '');
  const err = (k: FieldKey): string | null =>
    fieldErrors?.[k] ?? (touched && blanks.includes(k) ? labelOf(k) + '是必填的' : null);
  const missing = blanks.length + Object.keys(fieldErrors ?? {}).length;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (blanks.length > 0) return;
    onSubmit({ type, title: title.trim() });
  }

  return (
    <AuthShell title='申诉 / 反馈' subtitle={cfg.intro} footer={guest ? MOCK_GUEST.guestIntro : MOCK_GUEST.selfIntro}>
      {submitError ? <FormAlert tone='error' title='没能提交' description={submitError} /> : null}
      {touched && missing > 0 ? (
        <FormAlert
          tone='warning'
          title={'还有 ' + missing + ' 项没填好'}
          description='下面标红的就是要改的地方。填完再点一次提交即可，已经填好的内容不会丢。'
        />
      ) : null}

      <form onSubmit={submit} noValidate className='flex flex-col gap-3'>
        <Select
          type={SelectType.INPUT}
          label='事由'
          size={Size.FULL}
          data={TYPE_ITEMS}
          selected={TYPE_ITEMS.find((i) => i.key === type)!}
          onSelect={(item) => {
            if (item) onType(item.key as AppealType);
          }}
          disabled={pending}
        />

        {guest ? (
          <FormAlert
            tone='info'
            title='不用登录也能提交'
            description='封禁中的账号登不进来，所以这条链路不要求登录；代价是身份要靠自己证明：用户名与邮箱必须与账号注册信息一致，再加一个图形验证码挡住脚本批量提交。'
          />
        ) : (
          <div className='flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 text-[12px] leading-relaxed'>
            <span className='flex items-center gap-1.5 font-medium text-foreground'>
              <ShieldCheck size={14} aria-hidden className='text-[var(--ring-icon-success-color)]' />
              身份已确认（登录态）
            </span>
            <span className='text-muted-foreground'>
              账号 <span className='font-medium text-foreground'>{account.username}</span> · 注册邮箱{' '}
              <span className='font-medium text-foreground'>{account.email}</span>
            </span>
            <span className='text-muted-foreground'>身份字段只读：改不了，也用不着再证明一次。</span>
          </div>
        )}

        {guest ? (
          <Input
            label={FIELD.actor.label}
            size={Size.FULL}
            value={who}
            onChange={(e) => setWho(e.target.value)}
            error={err('actor')}
            help={FIELD.actor.help}
            placeholder={FIELD.actor.placeholder}
            name='appeal_user'
            autoComplete='off'
            disabled={pending}
          />
        ) : null}

        <Input
          label={FIELD.email.label}
          size={Size.FULL}
          value={guest ? email : account.email}
          onChange={(e) => setEmail(e.target.value)}
          error={err('email')}
          help={guest ? FIELD.email.help : '答复会发到这个邮箱（跟账号绑定，不可改）。'}
          placeholder={FIELD.email.placeholder}
          name='appeal_email'
          autoComplete='off'
          disabled={pending || !guest}
        />

        <Input
          label={cfg.ref.label}
          size={Size.FULL}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          error={err('ref')}
          help={cfg.ref.help}
          placeholder={cfg.ref.placeholder}
          name='appeal_ref'
          autoComplete='off'
          disabled={pending}
        />

        <Input
          label={FIELD.title.label}
          size={Size.FULL}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={err('title')}
          help='写清是哪件事：像「请复查 10-12 的封禁」比「求解封」有用得多。'
          placeholder={FIELD.title.placeholder}
          name='appeal_title'
          autoComplete='off'
          maxLength={80}
          disabled={pending}
        />

        <Input
          label={FIELD.details.label}
          size={Size.FULL}
          multiline
          rows={5}
          inputClassName='!h-[128px]'
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          error={err('details')}
          help='把时间、经过、你希望的结果写全，可以分段。'
          name='appeal_details'
          disabled={pending}
        />

        {guest ? (
          <Input
            label={FIELD.proof.label}
            size={Size.FULL}
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            help={FIELD.proof.help}
            placeholder={FIELD.proof.placeholder}
            name='appeal_proof'
            autoComplete='off'
            disabled={pending}
          />
        ) : null}

        <Input
          label={FIELD.contact.label}
          size={Size.FULL}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          help={FIELD.contact.help}
          placeholder={FIELD.contact.placeholder}
          name='appeal_contact'
          autoComplete='off'
          disabled={pending}
        />

        {guest ? (
          <CaptchaField
            chars={chars}
            value={captcha}
            onChange={setCaptcha}
            onRefresh={() => setChars(nextCaptcha(chars))}
            error={err('captcha')}
          />
        ) : null}

        <EvidenceSlot label={cfg.evidence.label} hint={cfg.evidence.hint} on={attach} onToggle={setAttach} disabled={pending} />

        <Button type='submit' primary inline={false} disabled={pending} loader={pending} className='w-full'>
          {pending ? '提交中…' : cfg.type === 'other' ? '提交反馈' : '提交申诉'}
        </Button>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>
          提交后立刻给你单号与答复时间（不会静默）。单号 + 提交时填的邮箱就是你查进展的凭据。
        </p>
      </form>
    </AuthShell>
  );
}

/**
 * 凭证附件位：**本轮只做位置与提示，不接上传**。
 * 为什么不做成空壳的「选择文件」：那会变成第二个「点了没反应」，而本轮验收目标就是少一个这种坑。
 * 所以它是一句说明 + 一个真能用（且已登记）的现有控件的指路。
 */
function EvidenceSlot({ label, hint, on, onToggle, disabled }: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className='flex flex-col gap-2 rounded-md border border-dashed border-border p-2.5'>
      <Checkbox label={label} checked={on} onChange={(e) => onToggle(e.target.checked as boolean)} disabled={disabled} />
      <span className='flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground'>
        <Paperclip size={12} aria-hidden className='mt-0.5 shrink-0' />
        {on ? (
          <span>
            上传通道还没接进本页：先把附件要说明的事写在「详细说明」里。现有的图片上传控件在{' '}
            <a className='underline' href={roomHref('09-rich')}>
              富文本与图片页
            </a>
            （已登记，可直接复用）。
          </span>
        ) : (
          <span>{hint}（勾上会展开这个位置）</span>
        )}
      </span>
      <span
        className='flex items-center gap-1 text-[10px] text-muted-foreground/80'
        title={protoTitle('申诉附件上传（类型 / 大小 / 存哪未定）')}
      >
        <CircleHelp size={10} aria-hidden />
        附件上传：未定，本轮只留位置
      </span>
    </div>
  );
}
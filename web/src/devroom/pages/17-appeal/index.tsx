import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { AppealForm } from './appeal-form';
import { AppealList } from './appeal-list';
import { SuccessView } from './success-view';
import { BanEntryDemo } from './ban-entry';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { roomHref } from '@/devroom/room-links';
import {
  APPEAL_TYPES,
  GUEST_VISIBLE_NOS,
  MOCK_GUEST,
  SERVER_APPEALS,
  nextNo,
  requiredKeys,
  TYPE_ALIAS,
  isAppealType,
  type AppealRecord,
  type AppealType,
  type FieldKey,
} from './data';
import { MOCK_ACCOUNT } from '@/devroom/pages/16-auth/data';

// ══════════════════════════════════════════════════════════════════════════════
// DevRoom 17 · 申诉与反馈（**可复用**：一个页面、多种事由、一条提交链路）
//
// 怎么加一种新事由 → 只看 data.ts 的 APPEAL_TYPES，加一条配置（key / 说明 / 必填字段 / 成功文案）。
// 本文件与 appeal-form.tsx 里**没有** if (type === 'ban') 这种分支：事由是数据，不是代码。
//
// 为什么必须有这一页：完全重构/盲审合并结论.md §7 —— 登录页告诉被封的人「在社区里联系管理员」，
// 但被封者登不进来、也发不了帖，这个闭环是断的。所以本页有两条身份路：
//   未登录（被封的人）: 用户名 + 注册邮箱 + 图形验证码；
//   已登录: 身份自动带出、只读（帖子被驳回那种事由走这条，作者本人）。
// 提交后必须给回执（单号 / 多久答复 / 去哪看），盲审二号报过「点完申诉界面不变 → 用户重复点」。
//
// 站内链接一律 ?page=<key>（房间挂在旧站域名下，/p/xxx 这类路径会落到旧站 404 —— 盲审一号报过）。
// 本页复用（不新造）：16-auth 的 CaptchaField / AuthShell / FormAlert、15-admin 的 Pill。
// ══════════════════════════════════════════════════════════════════════════════

/** 演示：从 URL 取初值（房间惯例：?page=17-appeal&actor=guest&type=ban&scene=sent） */
function readParam(key: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

function initType(): AppealType {
  const raw = readParam('type');
  const v = TYPE_ALIAS[raw] ?? raw;
  return isAppealType(v) ? v : 'ban';
}

export default function AppealPage() {
  const [actor, setActor] = useState<'guest' | 'self'>(() => (readParam('actor') === 'self' ? 'self' : 'guest'));
  const [type, setType] = useState<AppealType>(initType);
  const [scene, setScene] = useState<'form' | 'sent'>(() => (readParam('scene') === 'sent' ? 'sent' : 'form'));
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>> | undefined>(undefined);
  const [records, setRecords] = useState<AppealRecord[]>(() =>
    SERVER_APPEALS.filter((r) => GUEST_VISIBLE_NOS.includes(r.no)),
  );
  const [seq, setSeq] = useState(0);
  // 回执快照。三件事：① 结果态要显示「刚提交的那一条」，不能用之后再变的 type；
  // ② ?scene=sent 直接进来时也要看得到回执（否则出这一格图得先手填一张表）；
  // ③ 初值用固定假号 ap-2500：出图可复现，且不依赖 nextNo 的定义顺序。
  const [last, setLast] = useState<{ cfg: (typeof APPEAL_TYPES)[number]; no: string; guest: boolean } | null>(() =>
    readParam('scene') === 'sent' ? { cfg: APPEAL_TYPES.find((t) => t.type === initType())!, no: 'ap-2500', guest: true } : null,
  );
  const [resetKey, setResetKey] = useState(0);

  const cfg = APPEAL_TYPES.find((t) => t.type === type)!;
  /** 驳回申诉只认作者本人：未登录时连「哪篇帖子」都证明不了，先让他登录（这条要说出来，不能静默拦） */
  const loginFirst = actor === 'guest' && cfg.selfOnly;

  function switchActor(next: 'guest' | 'self') {
    setActor(next);
    setScene('form');
    setFieldErrors(undefined);
    setSubmitError(null);
    setRecords(SERVER_APPEALS.filter((r) => (next === 'guest' ? GUEST_VISIBLE_NOS.includes(r.no) : true)));
  }

  /**
   * 出回执：真提交与演示控制台共用一条。
   * 为什么共用：原来演示条的「提交后（回执）」只 setScene('sent')，而回执门的条件是
   * scene==='sent' && last —— 按下去还是表单（等于一个点了没反应的按钮，正是本页要消灭的那种）。
   */
  function receipt(v?: { type: AppealType; title: string }) {
    const conf = APPEAL_TYPES.find((t) => t.type === v?.type)!;
    const no = nextNo(seq);
    setScene('sent');
    setLast({ cfg: conf, no, guest: actor === 'guest' });
    setSeq((n) => n + 1);
    if (!v) return;
    // 只有真提交才往「我的申诉」里插记录：演示回执不该伪造一条用户没提交过的记录
    setRecords((prev) => [
      { no, type: v.type, title: v.title, status: 'pending', submittedAt: '刚刚', eta: conf.done.eta },
      ...prev,
    ]);
  }

  function submit(v: { type: AppealType; title: string }) {
    setPending(true);
    setSubmitError(null);
    setFieldErrors(undefined);
    // 设计页：只演示「提交中 → 回执」，不真的发请求（真实现：POST 后 202 + 单号）
    window.setTimeout(() => {
      setPending(false);
      receipt(v);
    }, 700);
  }

  return (
    <div className='flex flex-col gap-4'>
      <p className='text-[13px] leading-relaxed text-muted-foreground'>
        申诉 / 反馈：<strong className='font-medium text-foreground'>一个页面、四种事由、一条提交链路</strong>
        —— 事由的文案、必填项、成功文案都来自 <code className='rounded-sm bg-muted px-1 text-[12px]'>data.ts</code> 的
        APPEAL_TYPES 数组，加一种事由只加一条配置，不动 JSX。本页
        <strong className='font-medium text-foreground'>未登录也能提交</strong>
        ：被封的人登不进来，「在社区里联系管理员」那条路对他不存在，所以这里用 用户名 + 邮箱 + 图形验证码（复用
        16-auth 的控件）自证身份。
        提交后必须给回执（单号 / 多久答复 / 去哪看）—— 点完不能让界面看着没变，否则用户以为没点上。
        未登录那条路能查什么、不能查什么，文案里写死：单号在未登录时只活在本页这一次会话里。
      </p>

      <section
        aria-label='DevRoom 演示控制台'
        className='flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-3'
      >
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] font-medium text-foreground'>身份</span>
          <Button primary={actor === 'guest'} onClick={() => switchActor('guest')}>
            未登录（被封的人）
          </Button>
          <Button primary={actor === 'self'} onClick={() => switchActor('self')}>
            已登录
          </Button>
          <span className='text-[11px] text-muted-foreground'>切身份会清空表单，避免两种身份的表单串味</span>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] font-medium text-foreground'>事由</span>
          {APPEAL_TYPES.map((t) => (
            <Button
              key={t.type}
              active={t.type === type}
              onClick={() => {
                setType(t.type);
                setScene('form');
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] font-medium text-foreground'>状态</span>
          <Button primary={scene === 'form'} onClick={() => setScene('form')}>
            填表中
          </Button>
          <Button primary={scene === 'sent' && !pending} onClick={() => receipt()}>
            提交后（回执）
          </Button>
          <Button
            primary={pending}
            onClick={() => {
              setScene('form');
              setPending(true);
              window.setTimeout(() => setPending(false), 3000);
            }}
          >
            提交中（按钮禁用 + 进度）
          </Button>
          <Button
            primary={!!submitError}
            onClick={() => {
              setScene('form');
              setSubmitError('同一个账号 24 小时内最多提交 3 条申诉，请明天再试（429 appeal.rate_limited）。');
            }}
          >
            限流 429
          </Button>
          <Button
            primary={!!fieldErrors}
            onClick={() => {
              setScene('form');
              setFieldErrors({
                email: '这个邮箱与账号注册邮箱不一致',
                captcha: '验证码不正确，请重新输入',
              });
            }}
          >
            服务端字段错误
          </Button>
          {(submitError || fieldErrors) ? (
            <Button
              onClick={() => {
                setSubmitError(null);
                setFieldErrors(undefined);
              }}
            >
              清掉错误
            </Button>
          ) : null}
        </div>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>
          当前事由：{cfg.label} · 必填 {requiredKeys(cfg, actor).length} 项（
          {requiredKeys(cfg, actor).join(' / ')}）。{MOCK_GUEST.errorNote} 事由与身份都可以从 URL 给：
          ?page=17-appeal&amp;actor=self&amp;type=review_reject&amp;scene=sent
        </p>
      </section>

      {loginFirst ? (
        <FormAlert
          tone='warning'
          title='这一种事由需要先登录'
          description='帖子审核被驳回只有作者本人能申诉，而未登录时我们无法证明「你就是作者」。被封禁是否属于这种情况要另说：封禁申诉不需要登录 —— 换回「账号封禁申诉」就能直接提交。'
        >
          <div className='mt-2 flex flex-wrap items-center gap-2'>
            <Button primary inline={false} href={roomHref('16-auth')}>
              去登录 / 注册
            </Button>
            <Button
              onClick={() => {
                setType('ban');
                setScene('form');
              }}
            >
              改投封禁申诉（不用登录）
            </Button>
          </div>
        </FormAlert>
      ) : null}

      <div className='grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]'>
        <div className='flex flex-col gap-3'>
          {scene === 'sent' && last ? (
            <SuccessView
              cfg={last.cfg}
              no={last.no}
              guest={last.guest}
              onAgain={() => {
                setScene('form');
                setResetKey((k) => k + 1);
              }}
            />
          ) : (
            <AppealForm
              key={actor + type + resetKey}
              actor={actor}
              account={MOCK_ACCOUNT}
              type={type}
              onType={setType}
              fieldErrors={fieldErrors}
              submitError={submitError}
              pending={pending}
              onSubmit={submit}
            />
          )}
          <BanEntryDemo />
        </div>
        <AppealList records={records} guest={actor === 'guest'} />
      </div>
    </div>
  );
}

import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ForgotView } from './forgot-view';
import { LoginView } from './login-view';
import { RegisterView } from './register-view';
import { VerifyView } from './verify-view';
import {
  AUTH_VIEWS,
  AUTH_VIEW_LABEL,
  SCENES_BY_VIEW,
  VIEW_ALIAS,
  type AuthView,
  type ForgotScene,
  type LoginScene,
  type RegisterScene,
  type VerifyScene,
} from './data';

// DevRoom 16 · 登录 / 注册 / 找回密码 / 输入验证码（F3）
// 四个视图 + 登录七种情形，全部照 完全重构/后端开工前拍板.md §11（邮箱激活=6 位验证码，不是链接）
// 与 §9.6（登录页七种情形）、d2-auth.md §7/§10 做分支。
// 视图与情形都可以从 URL 指定（?view=verify&case=wrong），这样出图可复现、评审能直接跳到某一格；
// DevRoom 没有 router，所以只在这里读一次查询串当初值，页面内部状态仍然是 React 状态。
export default function AuthPage() {
  const [view, setView] = useState<AuthView>(() => {
    const raw = readParam('view');
    const aliased = VIEW_ALIAS[raw] ?? raw;
    return AUTH_VIEWS.includes(aliased as AuthView) ? (aliased as AuthView) : 'login';
  });
  const [picked, setPicked] = useState(() => readParam('case'));

  const scenes = SCENES_BY_VIEW[view];
  // URL 里的 case 只认当前视图的取值，认不出就用第一条
  const scene = scenes.find((s) => s.key === picked) ?? scenes[0]!;

  function switchView(next: AuthView) {
    setView(next);
    setPicked('');
  }

  return (
    <div className='flex flex-col gap-4'>
      <p className='text-[13px] leading-relaxed text-muted-foreground'>
        登录类页面：四个视图共用同一张 420 宽卡片。邮箱激活走
        <strong className='font-medium text-foreground'>6 位验证码</strong>
        （不发链接，换设备也能激活），所以「注册成功」直接落到「输入验证码」页、找回密码是「验证码 + 新密码」两步一页。
        登录页另外把七种情形都做出来。下面这块虚线框是 DevRoom 的演示控制台，真实页面里没有它。
      </p>

      <section
        aria-label='DevRoom 演示控制台'
        className='flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-3'
      >
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] font-medium text-foreground'>视图</span>
          {AUTH_VIEWS.map((v) => (
            <Button key={v} primary={v === view} onClick={() => switchView(v)}>
              {AUTH_VIEW_LABEL[v]}
            </Button>
          ))}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] font-medium text-foreground'>情形</span>
          {scenes.map((s) => (
            <Button key={s.key} active={s.key === scene.key} onClick={() => setPicked(s.key)}>
              {s.no + ' · ' + s.label}
            </Button>
          ))}
        </div>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>{scene.hint}</p>
      </section>

      {view === 'login' ? (
        <LoginView key={scene.key} scene={scene.key as LoginScene} onScene={setPicked} onView={switchView} />
      ) : null}
      {view === 'register' ? (
        <RegisterView key={scene.key} scene={scene.key as RegisterScene} onView={switchView} />
      ) : null}
      {view === 'verify' ? <VerifyView key={scene.key} scene={scene.key as VerifyScene} onView={switchView} /> : null}
      {view === 'forgot' ? (
        <ForgotView key={scene.key} scene={scene.key as ForgotScene} onScene={setPicked} onView={switchView} />
      ) : null}
    </div>
  );
}

/** DevRoom 惯例（13-issue / 14-home / 15-admin 同款）：查询串只用来给演示选初值 */
function readParam(key: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

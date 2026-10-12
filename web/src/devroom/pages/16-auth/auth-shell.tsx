import type { ReactNode } from 'react';
import { assetUrl } from '@/lib/url';

// 登录类页面的外壳：**居中一张 420 宽的小卡片**，上方站点标识、下方一句页脚小字。
// 五个视图共用它，所以「登录/注册/找回/重置/验证」看起来是同一套页面，不是五张设计稿。
export type AuthShellProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** 页脚小字：安全提示、申诉入口这类 */
  footer?: string;
};

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className='flex flex-col items-center gap-4 py-2'>
      <div className='flex items-center gap-2'>
        <img src={assetUrl('starcraft/sc2-logo.webp')} alt='' width={28} height={28} className='size-7 object-contain' />
        <span className='text-[15px] font-semibold text-foreground'>{'SC2clud'}</span>
        <span className='text-[12px] text-muted-foreground'>{'星际争霸战役社区'}</span>
      </div>
      <section className='w-full max-w-[420px] rounded-lg border border-border bg-card p-5'>
        <h2 className='text-base font-semibold text-foreground'>{title}</h2>
        {subtitle ? <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>{subtitle}</p> : null}
        <div className='mt-4 flex flex-col gap-3'>{children}</div>
      </section>
      {footer ? (
        <p className='max-w-[420px] text-center text-[11px] leading-relaxed text-muted-foreground'>{footer}</p>
      ) : null}
    </div>
  );
}

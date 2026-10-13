import { LifeBuoy } from 'lucide-react';
import { roomHref } from '@/devroom/room-links';

// 登录页那两个位置用的**同一个入口**（本页是它的家，16-auth 只引用它，避免两处文案各写一份）。
// 两个位置：
//   ① 登录页常规位置：卡片下方那句「账号被封了？提交申诉」，替代原来那句「在社区里联系管理员」；
//   ② 登录页「账号已被封禁」那一态：提示里直接给按钮 —— 被封的人此刻正卡在这一屏，别让他再找。
//
// 为什么用 <a> 而不是 Ring Button：它在登录页是**页脚小字**（同 16-auth 其它 footer 文案的样式），
// 不是一排按钮；Ring Button 的 inline 形态会带库的链接色与内边距，跟那句小字排不到一起。
// 链接走 roomHref()：**房间里**必须用 ?page=<key>（房间挂在旧站域名下，写成 /appeal 或 /p/xxx
// 会落到旧站 404 —— 盲审一号报过）。真页面（src/routes）里这一处要换成 appPath('/appeal?type=ban')。
export function BanEntry({ where }: { where: 'footer' | 'banned' }) {
  return (
    <span className='inline-flex flex-wrap items-center gap-1'>
      <LifeBuoy size={12} aria-hidden className='shrink-0 text-muted-foreground' />
      <span className='text-muted-foreground'>
        {where === 'banned' ? '账号被封了？' : '账号被封了（或被驳回了帖子）？'}
      </span>
      <a className='underline' href={roomHref('17-appeal') + '&type=ban'}>
        提交申诉
      </a>
      <span className='text-muted-foreground'>（不用登录，填用户名 + 注册邮箱 + 验证码）</span>
    </span>
  );
}

/** 本页底部把这两个位置摊开显示一次：改文案时能一眼看到它在登录页长什么样。 */
export function BanEntryDemo() {
  return (
    <section className='rounded-lg border border-dashed border-border p-3'>
      <h2 className='text-[13px] font-semibold text-foreground'>入口长什么样（16-auth 里渲染的就是它）</h2>
      <div className='mt-2 flex flex-col gap-2 text-[11px] leading-relaxed'>
        <div>
          <span className='mr-2 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground'>登录页 · 卡片下</span>
          <BanEntry where='footer' />
        </div>
        <div>
          <span className='mr-2 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground'>登录页 · 封禁态</span>
          <BanEntry where='banned' />
        </div>
      </div>
    </section>
  );
}

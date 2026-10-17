import Button from '@jetbrains/ring-ui-built/components/button/button';
import { SearchX } from 'lucide-react';
import { appPath } from '@/lib/url';

export function NotFoundPage() {
  return (
    <section className='flex flex-col items-center gap-3 py-20 text-center'>
      <SearchX aria-hidden className='size-8 text-muted-foreground' />
      <h1 className='m-0 text-[20px] font-semibold text-foreground'>404 · 页面不存在</h1>
      <p className='m-0 max-w-[46ch] text-[13px] leading-relaxed text-muted-foreground'>
        地址写错了、帖子被删了，或者它从来不存在。下面这条路一定通。
      </p>
      <span className='flex flex-wrap items-center justify-center gap-2 pt-1'>
        <Button primary href={appPath('')}>
          回首页
        </Button>
        <Button href={appPath('search')}>去搜索</Button>
      </span>
    </section>
  );
}

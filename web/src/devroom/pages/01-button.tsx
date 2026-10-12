import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import add from '@jetbrains/icons/add-20px';
import trash from '@jetbrains/icons/trash-20px';
import { Plus, Trash2, ArrowRight, ChevronDown, Loader } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 开发者房间 01 · 按钮（验证页）
// 布局：密集网格——每格「上面小标签 + 下面实物」，一屏尽量看完。
// 每一格都是实测过的用法；登记见 src/devroom/registry.ts。
function Cell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2.5'>
      <span className='flex min-w-0 flex-col gap-0.5'>
        <span className='truncate text-[12px] font-medium text-foreground'>{label}</span>
        {hint ? <span className='line-clamp-2 text-[11px] leading-snug text-muted-foreground'>{hint}</span> : null}
      </span>
      <span className='flex min-h-9 flex-wrap items-center gap-2'>{children}</span>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-2'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{title}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{desc}</p>
      </div>
      <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-4'>{children}</div>
    </section>
  );
}

export default function ButtonPage() {
  return (
    <div className='flex flex-col gap-6'>
      <Section title='1. 视觉变体' desc='同屏 primary 只出现一次（一个主操作）。'>
        <Cell label='默认（次级）' hint='不传变体 prop'><Button>按钮</Button></Cell>
        <Cell label='primary' hint='主操作'><Button primary>发帖</Button></Cell>
        <Cell label='danger' hint='删除 / 封禁'><Button danger>删除</Button></Cell>
        <Cell label='success' hint='确认类'><Button success>已通过</Button></Cell>
        <Cell label='error' hint='失败态'><Button error>校验失败</Button></Cell>
        <Cell label='ghost' hint='主操作旁边'><Button ghost>取消</Button></Cell>
        <Cell label='transparent' hint='卡片 / 列表内'><Button transparent>更多</Button></Cell>
        <Cell label='inline' hint='正文里的动作'><Button inline>展开</Button></Cell>
        <Cell label='short' hint='密集列表'><Button short>短按钮</Button></Cell>
        <Cell label='disabled'><Button disabled>禁用</Button></Cell>
        <Cell label='loader' hint='提交中，不可重复点'><Button loader>提交中</Button></Cell>
        <Cell label='active' hint='筛选已生效'><Button active>已选中</Button></Cell>
        <Cell label='dropdown' hint='配 PopupMenu'><Button dropdown>排序</Button></Cell>
      </Section>

      <Section title='2. 高度' desc='用 ControlsHeight 枚举；没有 size 这个 prop。'>
        <Cell label='S'><Button height={ControlsHeight.S}>小</Button></Cell>
        <Cell label='M（默认）'><Button height={ControlsHeight.M}>中</Button></Cell>
        <Cell label='L'><Button height={ControlsHeight.L}>大</Button></Cell>
        <Cell label='L + primary'><Button height={ControlsHeight.L} primary>大主操作</Button></Cell>
      </Section>

      <Section
        title='3. 图标'
        desc='Ring UI 按图标固有尺寸排版：官方图标自带尺寸；lucide 必须 icon16() 包装。'
      >
        <Cell label='✅ 官方图标 @jetbrains/icons' hint='自带固有尺寸，直接传'>
          <Button icon={add}>新建</Button>
          <Button primary icon={add}>新建</Button>
        </Cell>
        <Cell label='✅ lucide + icon16()' hint='统一 16px，基线对齐'>
          <Button icon={icon16(Plus)}>新建</Button>
          <Button primary icon={icon16(Trash2)}>删除</Button>
        </Cell>
        <Cell label='❌ lucide 原样（24px）' hint='对照：图标更大、按钮被顶高'>
          <Button icon={Plus}>新建</Button>
          <Button icon={Trash2}>删除</Button>
        </Cell>
        <Cell label='iconRight'>
          <Button iconRight={icon16(ArrowRight)}>下一步</Button>
          <Button iconRight={icon16(ChevronDown)} dropdown>排序</Button>
        </Cell>
        <Cell label='仅图标' hint='必须给 aria-label'>
          <Button icon={add} aria-label='新建主题' />
          <Button icon={icon16(Loader)} aria-label='刷新' />
          <Button primary icon={trash} aria-label='删除' />
        </Cell>
      </Section>

      <Section title='4. 链接按钮与提交态' desc='导航用 href（可中键新开）；提交中用 loader，不要用「提交后禁用」防重。'>
        <Cell label='href 渲染成链接'><Button href='/b/campaign'>进入分区</Button></Cell>
        <Cell label='提交空闲'><Button primary>提交</Button></Cell>
        <Cell label='提交中'><Button primary loader>提交中</Button></Cell>
      </Section>
    </div>
  );
}

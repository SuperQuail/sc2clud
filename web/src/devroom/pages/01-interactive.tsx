import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { icon16 } from '@/ui/icons';
import add from '@jetbrains/icons/add-20px';
import searchIcon from '@jetbrains/icons/search-20px';
import { Trash2, ArrowRight } from 'lucide-react';

// DevRoom 01 · 交互与表单
// 按「交互类型」组织，不按控件切小节：按钮一个区、输入一个区。
// 每一格都是实测过的用法；登记见 src/devroom/registry.ts。
function Area({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-3'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{title}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{desc}</p>
      </div>
      <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-4'>{children}</div>
    </section>
  );
}

function Cell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5 rounded-md border border-border p-2.5'>
      <span className='flex min-w-0 flex-col gap-0.5'>
        <span className='truncate text-[12px] font-medium text-foreground'>{label}</span>
        {hint ? <span className='line-clamp-2 text-[11px] leading-snug text-muted-foreground'>{hint}</span> : null}
      </span>
      <span className='flex min-h-10 flex-wrap items-center gap-2'>{children}</span>
    </div>
  );
}

export default function InteractivePage() {
  return (
    <div className='flex flex-col gap-4'>
      <Area
        title='按钮 · 常见场景'
        desc='同屏 primary 只出现一次；图标优先用官方 @jetbrains/icons，lucide 必须 icon16() 包装。'
      >
        <Cell label='主操作 + 次操作' hint='primary 只有一个'>
          <Button primary>发帖</Button>
          <Button>取消</Button>
        </Cell>
        <Cell label='危险操作' hint='删除/封禁，配确认框'>
          <Button danger>删除</Button>
        </Cell>
        <Cell label='幽灵 / 透明' hint='卡片、列表里的轻动作'>
          <Button ghost>取消</Button>
          <Button transparent>更多</Button>
        </Cell>
        <Cell label='禁用 / 提交中' hint='提交中用 loader，不要用「提交后禁用」防重'>
          <Button disabled>禁用</Button>
          <Button primary loader>提交中</Button>
        </Cell>
        <Cell label='带图标' hint='官方图标自带固有尺寸'>
          <Button icon={add}>新建</Button>
          <Button iconRight={icon16(ArrowRight)}>下一步</Button>
        </Cell>
        <Cell label='仅图标' hint='必须给 aria-label'>
          <Button icon={add} aria-label='新建' />
          <Button icon={icon16(Trash2)} aria-label='删除' />
        </Cell>
        <Cell label='链接按钮' hint='导航用 href，可中键新开'>
          <Button href='/b/campaign'>进入分区</Button>
        </Cell>
        <Cell label='尺寸' hint='ControlsHeight.S / M / L'>
          <Button height={ControlsHeight.S}>S</Button>
          <Button height={ControlsHeight.M}>M</Button>
          <Button height={ControlsHeight.L}>L</Button>
        </Cell>
        <Cell label='行内动作 / 紧凑' hint='正文里的动作、密集列表'>
          <Button inline>展开</Button>
          <Button short>短按钮</Button>
        </Cell>
      </Area>

      <Area
        title='输入 · Input'
        desc='label / error / help / icon / multiline 都是控件自带 prop，不要自己在外面拼标签与错误行。'
      >
        <Cell label='默认'><Input placeholder='搜索…' /></Cell>
        <Cell label='带标签' hint='label prop'>
          <Input label='标题' placeholder='给主题起个名字…' />
        </Cell>
        <Cell label='错误态' hint='error prop（服务端 fields 回填到这里）'>
          <Input label='邮箱' value='abc' error='邮箱格式不正确' onChange={() => {}} />
        </Cell>
        <Cell label='带说明' hint='help prop'>
          <Input label='用户名' help='登录名注册后不可修改' placeholder='3-24 位字母数字' />
        </Cell>
        <Cell label='带图标' hint='icon prop，官方图标'><Input icon={searchIcon} placeholder='搜索…' /></Cell>
        <Cell label='多行' hint='multiline，用于回复框'>
          <Input multiline placeholder='说点什么…' />
        </Cell>
        <Cell label='禁用'><Input disabled value='不可编辑' onChange={() => {}} /></Cell>
        <Cell label='大尺寸'><Input height={ControlsHeight.L} placeholder='大尺寸输入' /></Cell>
      </Area>
    </div>
  );
}

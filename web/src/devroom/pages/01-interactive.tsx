import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { DropdownItem, DropdownPanel } from '@/ui/dropdown-panel';
import { VividSwitch } from '@/ui/vivid/switch';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import add from '@jetbrains/icons/add-20px';
import searchIcon from '@jetbrains/icons/search-20px';
import { Heart, Plus, Search, Send } from 'lucide-react';
import { appPath } from '@/lib/url';
import { VividButton } from '@/ui/vivid/button';
import { VividInput } from '@/ui/vivid/input';

// DevRoom 01 · 交互与表单
// **一种控件两种样式，左右对照**：左边用户向（B 系 · Tailwind），右边开发者向（A 系 · Ring UI）。
// 不按「控件一页」也不按「人群一页」：选型时要在同一屏里比同一件事。
function Pair({
  name,
  note,
  user,
  dev,
}: {
  name: string;
  note: string;
  user: React.ReactNode;
  dev: React.ReactNode;
}) {
  return (
    <section className='flex flex-col gap-2'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{name}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      </div>
      <div className='grid gap-3 lg:grid-cols-2'>
        <div className='flex flex-col gap-3 rounded-lg border border-border bg-card p-3'>
          <div className='flex items-baseline gap-2'>
            <span className='rounded-sm bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary'>B 系 · 用户向</span>
            <span className='text-[11px] text-muted-foreground'>首页 / 分区页 / 帖子页</span>
          </div>
          <div className='flex flex-col gap-4'>{user}</div>
        </div>
        <div className='flex flex-col gap-3 rounded-lg border border-border bg-card p-3'>
          <div className='flex items-baseline gap-2'>
            <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground'>A 系 · 开发者向</span>
            <span className='text-[11px] text-muted-foreground'>发帖 / 管理 / 密集列表</span>
          </div>
          <div className='flex flex-col gap-4'>{dev}</div>
        </div>
      </div>
    </section>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[11px] text-muted-foreground'>{label}</span>
      <span className='flex flex-wrap items-center gap-2'>{children}</span>
    </div>
  );
}

export default function InteractivePage() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  return (
    <div className='flex flex-col gap-6'>
      <Pair
        name='按钮'
        note='同一个动作，两种体量。B 系高 40/48px、全圆角、饱和；A 系 24px、克制、密集。'
        user={
          <>
            <Line label='主操作 / 次操作'>
              <VividButton icon={Plus}>发帖</VividButton>
              <VividButton tone='soft'>收藏</VividButton>
            </Line>
            <Line label='强调 / 危险'>
              <VividButton tone='accent' icon={Heart}>赞赏作者</VividButton>
              <VividButton tone='danger'>删除</VividButton>
            </Line>
            <Line label='大号 / 幽灵 / 仅图标'>
              <VividButton size='lg' icon={Send}>立即加入</VividButton>
              <VividButton tone='ghost'>稍后再说</VividButton>
              <VividButton size='icon' icon={Heart} aria-label='收藏' />
            </Line>
            <Line label='提交中 / 不可用'>
              <VividButton loading>提交中</VividButton>
              <VividButton disabled>不可用</VividButton>
            </Line>
          </>
        }
        dev={
          <>
            <Line label='主操作 / 次操作'>
              <Button primary>发帖</Button>
              <Button>取消</Button>
            </Line>
            <Line label='强调 / 危险'>
              <Button danger>删除</Button>
              <Button ghost>取消</Button>
            </Line>
            <Line label='尺寸 / 紧凑 / 仅图标'>
              <Button height={ControlsHeight.S}>S</Button>
              <Button height={ControlsHeight.M}>M</Button>
              <Button height={ControlsHeight.L}>L</Button>
              <Button short>紧凑</Button>
              <Button icon={add} aria-label='新建' />
            </Line>
            <Line label='提交中 / 禁用 / 链接'>
              <Button primary loader>提交中</Button>
              <Button disabled>禁用</Button>
              <Button href={appPath('b/campaign')}>进入分区</Button>
            </Line>
          </>
        }
      />

      <Pair
        name='输入框'
        note='B 系自带标签与错误行、圆角更大；A 系更紧凑，label/error/help 也是控件自带。'
        user={
          <>
            <Line label='默认 / 带图标'>
              <VividInput placeholder='搜索…' aria-label='搜索' />
              <VividInput placeholder='搜索…' icon={Search} aria-label='搜索' />
            </Line>
            <Line label='带标签 / 带说明'>
              <VividInput label='标题' placeholder='给主题起个名字…' />
              <VividInput label='用户名' hint='注册后不可修改' placeholder='3-24 位字母数字' />
            </Line>
            <Line label='错误态 / 大号 / 禁用'>
              <div className='w-56'><VividInput label='邮箱' value='abc' error='邮箱格式不正确' onChange={() => {}} /></div>
              <VividInput size='lg' placeholder='大号输入' aria-label='大号输入' />
              <VividInput disabled value='不可编辑' onChange={() => {}} aria-label='禁用' />
            </Line>
          </>
        }
        dev={
          <>
            <Line label='默认 / 带图标'>
              <Input placeholder='搜索…' />
              <Input icon={searchIcon} placeholder='搜索…' />
            </Line>
            <Line label='带标签 / 带说明'>
              <Input label='标题' placeholder='给主题起个名字…' />
              <Input label='用户名' help='注册后不可修改' placeholder='3-24 位字母数字' />
            </Line>
            <Line label='错误态 / 大号 / 禁用'>
              <Input label='邮箱' value='abc' error='邮箱格式不正确' onChange={() => {}} />
              <Input height={ControlsHeight.L} placeholder='大号输入' />
              <Input disabled value='不可编辑' onChange={() => {}} />
            </Line>
          </>
        }
      />

      <Pair
        name='开关 Toggle'
        note='B 系 28×48px 圆角开关（原生 role=switch，键盘可用）；A 系是 checkbox 输入，标签用 children，另有 leftLabel/help。'
        user={
          <>
            <Line label='开 / 关 / 禁用'>
              <VividSwitch checked={on} onChange={setOn} label='接收回复通知' hint='有人回复你时提醒' />
              <VividSwitch checked={off} onChange={setOff} label='公开我的收藏' />
              <VividSwitch checked disabled onChange={() => {}} label='不可用' />
            </Line>
          </>
        }
        dev={
          <>
            <Line label='开 / 关 / 禁用'>
              <Toggle checked={on} onChange={(e) => setOn(e.target.checked)}>接收回复通知</Toggle>
              <Toggle checked={off} onChange={(e) => setOff(e.target.checked)}>公开我的收藏</Toggle>
              <Toggle checked disabled onChange={() => {}}>不可用</Toggle>
            </Line>
          </>
        }
      />

      <Pair
        name='下拉面板 DropdownPanel（我们自己的）'
        note='触发器右侧有可点三角（展开时翻转）；面板有表头与条目 hover 态；**direction=auto 时下方放不下会向上弹**；Esc/点外部关闭。两侧共用同一个控件。'
        user={
          <>
            <Line label='点徽标/按钮展开'>
              <DropdownPanel label='排序方式' width='w-52' trigger={<VividButton tone='soft'>排序</VividButton>}>
                <DropdownItem onClick={() => {}}>最新回复</DropdownItem>
                <DropdownItem onClick={() => {}}>最新发布</DropdownItem>
                <DropdownItem onClick={() => {}}>最多回复</DropdownItem>
              </DropdownPanel>
            </Line>
          </>
        }
        dev={
          <>
            <Line label='点按钮展开'>
              <DropdownPanel label='排序方式' width='w-52' trigger={<Button dropdown>排序</Button>}>
                <DropdownItem onClick={() => {}}>最新回复</DropdownItem>
                <DropdownItem onClick={() => {}}>最新发布</DropdownItem>
                <DropdownItem onClick={() => {}}>最多回复</DropdownItem>
              </DropdownPanel>
            </Line>
          </>
        }
      />

      <section className='rounded-lg border border-dashed border-border p-3'>
        <h2 className='text-sm font-semibold text-foreground'>还没做对照的控件</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          下拉选择、复选/单选：B 系还没做（Ring UI 那侧已可用）。按这个页面的格式补上左右对照后，才允许在业务页面里用。
        </p>
        <div className='mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5'>Select</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5'>Dropdown</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5'>Checkbox</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5'>Radio</span>
          <span className='text-muted-foreground'>另：图标工具 icon16 / 官方图标仍在第 05 页。</span>
        </div>
      </section>
    </div>
  );
}

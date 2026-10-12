import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Search } from 'lucide-react';
import { Line, Pair } from '@/devroom/kit';
import { VividInput } from '@/ui/vivid/input';

export function InputPair() {
  return (
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
            <Input placeholder='搜索…' icon={undefined} />
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
  );
}

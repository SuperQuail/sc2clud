import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Heart, Plus, Send } from 'lucide-react';
import { appPath } from '@/lib/url';
import { Line, Pair } from '@/devroom/kit';
import { VividButton } from '@/ui/vivid/button';

export function ButtonPair() {
  return (
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
          </Line>
          <Line label='提交中 / 禁用 / 链接'>
            <Button primary loader>提交中</Button>
            <Button disabled>禁用</Button>
            <Button href={appPath('b/campaign')}>进入分区</Button>
          </Line>
        </>
      }
    />
  );
}

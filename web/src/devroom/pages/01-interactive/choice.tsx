import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Radio from '@jetbrains/ring-ui-built/components/radio/radio';
import { Line, Pair } from '@/devroom/kit';

// 复选 / 单选 / 按钮组，**全部用 Ring 现成控件**（不再自建）。
// 这三个的标签、禁用、帮助文字、键盘行为都由库负责——正是自建最容易漏的部分。
export function ChoicePair() {
  const [box, setBox] = useState(true);
  const [box2, setBox2] = useState(false);
  const [radio, setRadio] = useState('new');
  const [segment, setSegment] = useState(1);

  const boxes = (
    <Line label='选中 / 未选 / 禁用 / 带说明'>
      <Checkbox label='接收回复通知' checked={box} onChange={(e) => setBox(e.target.checked)} />
      <Checkbox label='公开我的收藏' checked={box2} onChange={(e) => setBox2(e.target.checked)} />
      <Checkbox label='不可用' disabled checked={false} onChange={() => {}} />
      <Checkbox label='同时转发到我的动态' help='会在动态里生成一条记录' checked={false} onChange={() => {}} />
    </Line>
  );
  const radios = (
    <Line label='单选组（同一 name 互斥）'>
      {/* 必须用 Radio.Item：Radio 本身不渲染 DOM（写成 <Radio>文案</Radio> 会得到一行不可点的纯文字，
          而且 typecheck 不报 —— 见 registry.ts 的 radio 条目）。 */}
      <Radio.Item name='sort' value='new' checked={radio === 'new'} onChange={() => setRadio('new')}>最新回复</Radio.Item>
      <Radio.Item name='sort' value='hot' checked={radio === 'hot'} onChange={() => setRadio('hot')}>最多回复</Radio.Item>
      <Radio.Item name='sort' value='old' checked={radio === 'old'} onChange={() => setRadio('old')}>最早发布</Radio.Item>
      <Radio.Item name='sort' value='off' disabled checked={false} onChange={() => {}}>不可用</Radio.Item>
    </Line>
  );
  const segs = (
    <Line label='按钮组 ButtonSet（连在一起的一组动作）'>
      <ButtonSet>
        <Button active={segment === 1} onClick={() => setSegment(1)}>全部</Button>
        <Button active={segment === 2} onClick={() => setSegment(2)}>精华</Button>
        <Button active={segment === 3} onClick={() => setSegment(3)}>待回复</Button>
      </ButtonSet>
    </Line>
  );

  return (
    <Pair
      name='复选 / 单选 / 按钮组'
      note='Checkbox、Radio、ButtonSet 都是 Ring 现成的；标签与帮助文字用控件自己的属性，不要自己在外面拼 <label>。'
      user={
        <>
          {boxes}
          {radios}
          {segs}
        </>
      }
      dev={
        <>
          <Line label='紧凑排布（管理表格里用）'>
            <Checkbox label='全选' checked={box} onChange={(e) => setBox(e.target.checked)} />
            <Checkbox label='仅看未处理' checked={false} onChange={() => {}} />
          </Line>
          {segs}
        </>
      }
    />
  );
}

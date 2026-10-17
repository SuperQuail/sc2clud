import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 只引 Ring UI 自己的样式：不引 Tailwind、不引我们的令牌桥接
import '@jetbrains/ring-ui-built/components/style.css';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';

// 隔离实验页：回答一个问题——按钮难看，是 Ring UI 本身，还是我们的集成（Tailwind preflight + 令牌桥接）造成的？
const rows: Array<[string, React.ReactNode]> = [
  ['默认', <Button>按钮</Button>],
  ['primary', <Button primary>发帖</Button>],
  ['danger', <Button danger>删除</Button>],
  ['ghost', <Button ghost>取消</Button>],
  ['height S', <Button height={ControlsHeight.S}>小</Button>],
  ['height M', <Button height={ControlsHeight.M}>中</Button>],
  ['height L', <Button height={ControlsHeight.L}>大</Button>],
  ['带图标', <Button primary icon={undefined}>发帖</Button>],
  ['输入框', <Input placeholder='输入点什么…' />],
];

function Page() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 16 }}>隔离实验：纯 Ring UI（无 Tailwind / 无令牌桥接）</h1>
      {rows.map(([label, el], i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 0', borderBottom: '1px solid #eee' }}>
          <span style={{ width: 90, fontSize: 13, color: '#666' }}>{label}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{el}</span>
        </div>
      ))}
    </div>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('#root 不存在');
createRoot(el).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);

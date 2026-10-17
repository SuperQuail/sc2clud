import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { Pencil, Search as SearchIcon } from 'lucide-react';
// Tailwind 先行，Ring UI 的全局样式随后：冲突时以 Ring UI 为准（它是控件基础）
import './styles.css';
import '@jetbrains/ring-ui-built/components/style.css';

function App() {
  const [text, setText] = useState('');
  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-6 p-8'>
      <h1 className='text-xl font-semibold'>Ring UI × Tailwind 共存实验</h1>
      <section className='flex items-center gap-3'>
        <Button primary>Ring UI 主按钮</Button>
        <Button>次按钮</Button>
        <Button icon={Pencil} title='编辑' />
      </section>
      <section className='flex items-center gap-3'>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder='Ring UI 输入框' />
        <Checkbox>Ring UI 复选框</Checkbox>
      </section>
      <section className='flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4'>
        <SearchIcon className='h-4 w-4 text-slate-500' />
        <span className='text-sm text-slate-600'>Tailwind 布局 + lucide-react 图标</span>
      </section>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

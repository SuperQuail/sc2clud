import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { ProbeEditor, sampleNotes } from './ai-bits';
import { fireEvent } from '@testing-library/react';

// D34（2026-10-15 用户实测「测试样例无法自己配置图片」）：样例编辑器要能**自己配图** ——
// 添加 / 移除 / 拒绝原因就地显示（名称 + 大小 + 为什么没发）。
// 张数与体积是**前端就地**的两条规则（与后端 images.go 同一套：>4 张、单张 >2 MiB）；
// 类型（「不是图片」）由后端判字节 —— 干跑回执里那一张的下场就是这句话，所见即所发。
//
// 先红：旧 ProbeEditor 没有选图入口，input[type=file] 根本不存在，选不了也显示不出。

/** input.files 是只读的，jsdom 没有 DataTransfer：按数组形状直接定义它（同 image-uploader.test 的做法）。 */
async function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type=file]');
  if (!input) throw new Error('样例编辑器没有挂选图入口（input[type=file] 不存在 —— 这就是旧行为下的红）');
  const list = Object.assign([...files], { item: (i: number) => files[i] ?? null });
  Object.defineProperty(input, 'files', { configurable: true, value: list });
  await act(async () => {
    fireEvent.change(input, { target: { files: list as unknown as FileList } });
  });
}

function Host({ busy = false }: { busy?: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <>
      <ProbeEditor value='样例' defaultValue='样例' onChange={() => {}} onReset={() => {}} busy={busy} files={files} onFilesChange={setFiles} />
      <span data-testid='host-count'>{String(files.length)}</span>
    </>
  );
}

const f = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'image/png' });

it('选图：就地显示 名称+大小，添加是**累加**而不是替换', async () => {
  const { container } = render(<Host />);
  await pick(container, [f('样例图一.png', 100), f('样例图二.png', 200)]);
  let chips = await screen.findAllByTestId('ai-probe-file');
  expect(chips).toHaveLength(2);
  expect(chips[0]?.textContent).toContain('样例图一.png');
  expect(chips[0]?.textContent).toContain('0 KB');
  expect(chips[1]?.textContent).toContain('样例图二.png');
  // 没被点的两张都没有拒绝原因
  expect(screen.queryByTestId('ai-probe-file-note')).toBeNull();
  expect(screen.getByTestId('host-count').textContent).toBe('2');

  // 再选一批：是「添加」，不是把前面两张挤掉
  await pick(container, [f('第三张.png', 300)]);
  chips = await screen.findAllByTestId('ai-probe-file');
  expect(chips).toHaveLength(3);
  expect(chips[2]?.textContent).toContain('第三张.png');
  expect(screen.getByTestId('host-count').textContent).toBe('3');
});

it('超过 4 张上限：第 5 张起就地给"超过 4 张上限"，一条不许静默', async () => {
  const { container } = render(<Host />);
  await pick(container, [f('一.png', 1), f('二.png', 1), f('三.png', 1), f('四.png', 1), f('五.png', 1), f('六.png', 1)]);
  const chips = await screen.findAllByTestId('ai-probe-file');
  expect(chips).toHaveLength(6);
  const notes = screen.getAllByTestId('ai-probe-file-note');
  expect(notes).toHaveLength(2); // 第 5、6 张
  expect(notes[0]?.textContent).toContain('超过 4 张上限');
  expect(notes[1]?.textContent).toContain('超过 4 张上限');
  // 全部保留在选择里（发给后端，由回执逐张记账）—— 前端只是先说原因
  expect(screen.getByTestId('host-count').textContent).toBe('6');
});

it('单张超过 2 MiB：就地给一句带数字的拒绝原因（3.1 MB 对照上限 2.0 MB）', async () => {
  const { container } = render(<Host />);
  const big = new File([new Uint8Array(3_250_586)], '超大的截图.png', { type: 'image/png' }); // 3.1 MB
  await pick(container, [f('正常.png', 4096), big]);
  const chips = await screen.findAllByTestId('ai-probe-file');
  expect(chips).toHaveLength(2);
  const notes = screen.getAllByTestId('ai-probe-file-note');
  expect(notes).toHaveLength(1);
  expect(notes[0]?.textContent).toContain('单张 3.1 MB 超过上限 2.0 MB');
  expect(chips[0]?.textContent).not.toContain('超过上限');
});

it('移除：点了就少一行，剩下的顺序与原因跟着重算', async () => {
  const { container } = render(<Host />);
  await pick(container, [f('一.png', 1), f('二.png', 1), f('三.png', 1), f('四.png', 1), f('五.png', 1)]);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: '移除 一.png' })[0]!);
  });
  const chips = await screen.findAllByTestId('ai-probe-file');
  expect(chips).toHaveLength(4);
  expect(chips[0]?.textContent).toContain('二.png');
  // 五.png 挤回第 4 位：不再超限，拒绝原因消失
  expect(screen.queryByTestId('ai-probe-file-note')).toBeNull();
});

it('sampleNotes（纯函数）：>4 张的 index 才有原因；>2 MiB 带数字；正常为空串', () => {
  const notes = sampleNotes([f('一.png', 1), f('二.png', 1), f('三.png', 1), f('四.png', 1), f('五.png', 1), f('六.png', 1)]);
  // 张数规则优先（与后端 probeImages 的 switch 同序）：既超张数又超体积的第 6 张说的是前者。
  // 体积的文案在上一条用例里带数字验过（3.1 MB 对照 2.0 MB）。
  expect(notes).toEqual(['', '', '', '', '超过 4 张上限，这一张没发', '超过 4 张上限，这一张没发']);
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { AVATAR_MAX_BYTES, IMAGE_ACCEPT, formatBytes } from '@/ui/rich/image-pipeline';
import { AccountPanel } from './account-panel';

// 盲审二号那四条（入口 / 两种失败态 / 上传入口 / 体积文案）锁在这里。
// 为什么断言"DOM 里有没有 input[type=file]"：入口缺失那次的症状就是**控件完备但数量为 0**，
// 只看组件源码看不出来——必须问渲染结果。

function fakeFile(name: string, size: number): File {
  // 管线只读 name/size，真分配 12MB 是浪费；但必须是真 File（键值真值判断）
  return Object.defineProperty(new File([], name, { type: 'image/png' }), 'size', { value: size });
}

function attach(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const passwordInputs = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLInputElement>('input[type=password]'));
const errorTexts = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('.ring-input-error')).map((e) => e.textContent ?? '');

it('上传头像：本人态真的渲染出 input[type=file]（原来数量是 0 的那个缺口）', () => {
  const { container } = render(<AccountPanel onAvatar={() => {}} onLogout={() => {}} />);
  const inputs = container.querySelectorAll('input[type=file]');
  expect(inputs.length).toBe(1);
  expect(inputs[0]!.getAttribute('accept')).toBe(IMAGE_ACCEPT);
});

it('体积上限：12MB 的图塞进头像位，报的是体积文案，不是"最多 1 张"', () => {
  const { container } = render(<AccountPanel onAvatar={() => {}} onLogout={() => {}} />);
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  act(() => attach(input, [fakeFile('huge.png', 12 * 1024 * 1024)]));
  const errors = screen.getAllByText(/没有加进来/).map((e) => e.textContent ?? '');
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('huge.png');
  expect(errors[0]).toContain(formatBytes(12 * 1024 * 1024)); // 12MB
  expect(errors[0]).toContain(formatBytes(AVATAR_MAX_BYTES)); // 上限 10MB
  expect(errors[0]).not.toContain('最多 1 张');
  expect(screen.queryByText(/最多 1 张/)).toBeNull();
});

it('体积上限：10MB 以内的图不会被体积文案拦下（走正常收图那条路）', async () => {
  // 成功路径要在 jsdom 里跑 canvas 压缩，jsdom 缺 createImageBitmap / getContext / toBlob：只补测试环境
  vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 600, close() {} }));
  const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
    cb(new Blob([new Uint8Array(1024)], { type: 'image/webp' }));
  });
  try {
    const seen: UploadedImage[][] = [];
    const { container } = render(<ImageUploader variant='avatar' label='上传头像' compress images={[]} onChange={(n) => seen.push(n)} />);
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    await act(async () => { attach(input, [fakeFile('phone.jpg', 5 * 1024 * 1024)]); });
    expect(screen.queryByText(/没有加进来/)).toBeNull();
    expect(seen.at(-1)?.length).toBe(1);
    expect(seen.at(-1)?.[0]?.name).toBe('phone.jpg');
  } finally {
    toBlob.mockRestore();
    ctx.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('改密码：两次不一致与当前密码错是两种能分辨的失败态', () => {
  const { container } = render(<AccountPanel onAvatar={() => {}} onLogout={() => {}} />);
  const [current, next, repeat] = passwordInputs(container);
  // 两次不一致：报错只出现在"确认新密码"上，当前密码不挨骂
  act(() => {
    fireEvent.change(current!, { target: { value: 'sc2clud' } });
    fireEvent.change(next!, { target: { value: 'newpass123' } });
    fireEvent.change(repeat!, { target: { value: 'newpass124' } });
  });
  act(() => screen.getByTestId('password-save').click());
  expect(errorTexts(container).some((t) => t.includes('不一样'))).toBe(true);
  expect(errorTexts(container).some((t) => t.includes('当前密码不对'))).toBe(false);
  expect(screen.queryByTestId('password-done')).toBeNull();

  // 两次一致但当前密码错：换成另一条消息
  act(() => {
    fireEvent.change(current!, { target: { value: 'wrong-one' } });
    fireEvent.change(repeat!, { target: { value: 'newpass123' } });
  });
  act(() => screen.getByTestId('password-save').click());
  expect(errorTexts(container).some((t) => t.includes('当前密码不对'))).toBe(true);
  expect(errorTexts(container).some((t) => t.includes('不一样'))).toBe(false);

  // 都对：出现成功态，三个框清空
  act(() => { fireEvent.change(current!, { target: { value: 'sc2clud' } }); });
  act(() => screen.getByTestId('password-save').click());
  expect(screen.getByTestId('password-done')).toBeTruthy();
  expect(passwordInputs(container).every((i) => i.value === '')).toBe(true);
});

it('退出登录：没退出时是按钮且点了有回调，退出后收起成"去登录"', () => {
  const onLogout = vi.fn();
  const { container, rerender } = render(<AccountPanel onAvatar={() => {}} onLogout={onLogout} />);
  act(() => screen.getByTestId('logout').click());
  expect(onLogout).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('input[type=file]').length).toBe(1);

  rerender(<AccountPanel onAvatar={() => {}} onLogout={onLogout} loggedOut />);
  expect(screen.queryByTestId('logout')).toBeNull();
  // 已退出：账号动作收起（改密码表单也收起，不留自相矛盾的状态），只留一条去登录的路
  expect(screen.queryByTestId('password-save')).toBeNull();
  expect(screen.getByRole('link', { name: '去登录' })).toBeTruthy();
  // 头像上传口也收起（已退出就没有可上传的会话）
  expect(container.querySelectorAll('input[type=file]').length).toBe(0);
});

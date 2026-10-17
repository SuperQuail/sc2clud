import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SOURCE_PROVIDERS, type SourceInput } from '@/lib/api/forum';
import { SourceEditor } from './source-editor';
import { PROVIDER_SITE, emptyForm, sourceBodyOf, sourceFieldErrors, type SourceRow } from './source-form';

// 下载来源编辑器的非平凡逻辑（校验、请求体字段名、词表）各留一条会红的检查（开发必读 §5）。
// 断言只查语义（testid / 请求体键名），不查 className。

const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: 's1',
  provider: 'baidu',
  label: '主线战役 v3.1',
  url: 'https://pan.baidu.com/s/1sc2clud',
  extraction_code: 'sc2c',
  size: '2.4 GB',
  verified_at: '2026-10-13T10:00:00Z',
  upkeep: 'active',
  ...over,
});

it('provider 词表与后端 binding 逐字一致，站点表一个不漏（写错一个词就是 400）', () => {
  // 出处：forum/internal/forum/sources.go validSourceInput 的 switch —— 改那边就要改这里。
  expect([...SOURCE_PROVIDERS]).toEqual([
    'baidu',
    'aliyun',
    'quark',
    'lanzou',
    'pan123',
    'weiyun',
    'onedrive',
    'mega',
    'website',
    'github',
    'gitee',
    'other',
  ]);
  // 下拉的选项与顺序都来自 PROVIDER_SITE：少一个站点就没有可选项，多一个后端会拒
  expect(Object.keys(PROVIDER_SITE)).toEqual([...SOURCE_PROVIDERS]);
});

it('sourceFieldErrors：与后端 validSourceInput 逐条对应，不是另编一套', () => {
  // 新表单默认站点是词表里的第一个，所以只缺链接
  expect(sourceFieldErrors(emptyForm())).toEqual({ url: '不能为空' });
  expect(sourceFieldErrors({ ...emptyForm(), url: 'pan.baidu.com/s/1' }).url).toBe('必须是 http(s) 链接');
  expect(sourceFieldErrors({ ...emptyForm(), url: 'https://a.b', label: '标'.repeat(61) }).label).toContain('60');
  expect(sourceFieldErrors({ ...emptyForm(), url: 'https://a.b', size: 'x'.repeat(17) }).size).toContain('16');
  // 提取码只收字母数字（后端 isAlnum），中文/空格都会被拒
  expect(sourceFieldErrors({ ...emptyForm(), url: 'https://a.b', extraction_code: '提取' }).extraction_code).toBeTruthy();
  expect(sourceFieldErrors({ ...emptyForm(), url: 'https://a.b', extraction_code: 'sc2c' })).toEqual({});
});

it('sourceBodyOf：请求体字段名与后端 sourceBody 逐字对应，空提取码送 null', () => {
  const body = sourceBodyOf({
    provider: 'pan123',
    label: ' 旧版 v2.9 ',
    url: ' https://www.123pan.com/s/demo ',
    extraction_code: '   ',
    size: ' 2.1 GB ',
  });
  expect(body).toEqual({
    provider: 'pan123',
    url: 'https://www.123pan.com/s/demo',
    label: '旧版 v2.9',
    extraction_code: null,
    size: '2.1 GB',
  });
});

it('编辑器：新增时把请求体原样交给调用方（键名就是后端认得的那五个），成功后给一行回执', async () => {
  const onSave = vi.fn<(body: SourceInput, id?: string) => Promise<undefined>>();
  const onDelete = vi.fn<(row: SourceRow) => Promise<undefined>>();
  render(<SourceEditor items={[row()]} onSave={onSave} onDelete={onDelete} onVerify={async () => undefined} />);
  expect(screen.getByTestId('source-row-s1')).toBeTruthy();

  fireEvent.click(screen.getByTestId('source-add'));
  fireEvent.change(screen.getByTestId('source-url'), { target: { value: 'https://www.aliyundrive.com/s/xyz' } });
  fireEvent.change(screen.getByTestId('source-label'), { target: { value: '备用链接' } });
  fireEvent.click(screen.getByTestId('source-save'));

  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  const [body, id] = onSave.mock.calls[0]!;
  expect(id).toBeUndefined();
  expect(Object.keys(body).sort()).toEqual(['extraction_code', 'label', 'provider', 'size', 'url']);
  expect(body.url).toBe('https://www.aliyundrive.com/s/xyz');
  expect(body.label).toBe('备用链接');
  expect((await screen.findByTestId('source-status')).textContent).toContain('已添加');
});

it('编辑器：链接不合法就不发请求，错在字段上', async () => {
  const onSave = vi.fn<(body: SourceInput, id?: string) => Promise<undefined>>();
  render(<SourceEditor items={[]} onSave={onSave} onDelete={async () => undefined} />);
  expect(screen.getByTestId('source-empty')).toBeTruthy();
  fireEvent.click(screen.getByTestId('source-add'));
  fireEvent.change(screen.getByTestId('source-url'), { target: { value: 'ftp://x.y' } });
  fireEvent.click(screen.getByTestId('source-save'));
  await waitFor(() => expect(screen.getByText('必须是 http(s) 链接')).toBeTruthy());
  expect(onSave).not.toHaveBeenCalled();
});

it('编辑器：编辑回填原值并带 id 提交；删除要再点一次（后端是物理删除）', async () => {
  const onSave = vi.fn<(body: SourceInput, id?: string) => Promise<undefined>>();
  const onDelete = vi.fn<(row: SourceRow) => Promise<undefined>>();
  render(<SourceEditor items={[row()]} onSave={onSave} onDelete={onDelete} onVerify={async () => undefined} />);

  fireEvent.click(screen.getByTestId('source-edit-s1'));
  expect((screen.getByTestId('source-url') as HTMLInputElement).value).toBe('https://pan.baidu.com/s/1sc2clud');
  expect((screen.getByTestId('source-code') as HTMLInputElement).value).toBe('sc2c');
  fireEvent.change(screen.getByTestId('source-size'), { target: { value: '2.5 GB' } });
  fireEvent.click(screen.getByTestId('source-save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0]![1]).toBe('s1');
  expect(onSave.mock.calls[0]![0].size).toBe('2.5 GB');

  // 第一下只是把确认摆出来，第二下才真删
  fireEvent.click(screen.getByTestId('source-delete-s1'));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('source-delete-confirm-s1'));
  await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  expect(onDelete.mock.calls[0]![0].id).toBe('s1');
});

it('编辑器：不能写时（disabled）画得出、点不动，行内动作全不画', () => {
  render(<SourceEditor items={[row()]} disabled onSave={async () => undefined} onDelete={async () => undefined} onVerify={async () => undefined} />);
  // 「添加来源」画出来但禁用（与全站写闸门同一口径：只给一句话，人不知道自己会失去什么）
  expect((screen.getByTestId('source-add') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByTestId('source-edit-s1')).toBeNull();
  expect(screen.queryByTestId('source-delete-s1')).toBeNull();
  expect(screen.queryByTestId('source-verify-s1')).toBeNull();
  // 但来源本身要看得见：不能写不等于看不见自己帖子的来源
  expect(screen.getByTestId('source-row-s1')).toBeTruthy();
});

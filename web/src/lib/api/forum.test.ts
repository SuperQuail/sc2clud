import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSource, deleteSource, updateSource, verifySource } from './forum';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 下载来源的四条端点（POST / PATCH / DELETE / verify）。这一组只看**发出去的那一行**：
// 路径、方法、请求体的字段名。字段名与后端 forum/internal/forum/handler.go 的 sourceBody 逐字对应
// （provider / label / url / extraction_code / size），与 dto.go 的 SourceInput 一致 ——
// 历史上「契约两侧各写一份、各自的测试都过」已经栽过 6 次，所以这里按字面钉住。
describe('下载来源端点', () => {
  it('新增：POST /topics/{id}/sources，体里是 provider/label/url/extraction_code/size', async () => {
    const { calls } = mockFetch([{ status: 201, body: { data: { id: 's1' } } }]);
    await createSource('tp-1', {
      provider: 'pan123',
      url: 'https://www.123pan.com/s/demo',
      label: '主线战役 v3.1',
      extraction_code: 'sc2c',
      size: '2.4 GB',
    });
    expect(calls[0]?.url).toContain('/api/v1/topics/tp-1/sources');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      provider: 'pan123',
      url: 'https://www.123pan.com/s/demo',
      label: '主线战役 v3.1',
      extraction_code: 'sc2c',
      size: '2.4 GB',
    });
  });

  it('修改：PATCH /topics/{id}/sources/{sid}，且是**整条替换**（provider 与 url 必须一起送，后端 required）', async () => {
    const { calls } = mockFetch([{ body: { data: { id: 's1' } } }]);
    await updateSource('tp-1', 's1', { provider: 'baidu', url: 'https://pan.baidu.com/s/1abc', extraction_code: null });
    expect(calls[0]?.url).toContain('/api/v1/topics/tp-1/sources/s1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['provider']).toBe('baidu');
    expect(body['url']).toBe('https://pan.baidu.com/s/1abc');
    expect(body['extraction_code']).toBeNull();
  });

  it('删除：DELETE /topics/{id}/sources/{sid}，204 没有响应体也不报错', async () => {
    const { calls } = mockFetch([{ status: 204 }]);
    await deleteSource('tp-1', 's1');
    expect(calls[0]?.url).toContain('/api/v1/topics/tp-1/sources/s1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('确认有效：POST /topics/{id}/sources/{sid}/verify', async () => {
    const { calls } = mockFetch([{ body: { data: { ok: true } } }]);
    await verifySource('tp-1', 's1');
    expect(calls[0]?.url).toContain('/api/v1/topics/tp-1/sources/s1/verify');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('id 里的特殊字符要转义（别拼出一个能打中别的端点的路径）', async () => {
    const { calls } = mockFetch([{ body: { data: { id: 's1' } } }]);
    await updateSource('tp 1', 's/1', { provider: 'other', url: 'https://a.b' });
    expect(calls[0]?.url).toContain('/api/v1/topics/tp%201/sources/s%2F1');
  });
});

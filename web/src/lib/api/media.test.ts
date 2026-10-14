import { afterEach, expect, it, vi } from 'vitest';
import { attachTopicImage, detachTopicImage } from './media';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 图文帖的配图通道。2026-10-14 之前 media 只有三条**专用**上传端点（头像 / 收款码 / 帖子配图），
// 而帖子配图那一条在 \`web/src\` 里**一个调用方都没有** —— 上传端点绑 topic、可见性固定 private、
// 前端连函数都没写（K2-A 的两条观察之一）。这一份钉的就是「谁在上传、发到哪、字段叫什么」。
// 契约真源：\`forum/internal/media/handler.go:50-53\` 与 \`dto.go\` 的 AttachedImage。
it('配图上传走 POST /topics/{id}/images，multipart 字段名 file（绝不套 JSON）', async () => {
  const { calls } = mockFetch([
    { status: 201, body: { data: { hash: 'a'.repeat(64), url: '/img/' + 'a'.repeat(64), width: 1600, height: 900, sort: 0 } } },
  ]);
  const out = await attachTopicImage('tp-1', new Blob(['x'], { type: 'image/webp' }));
  expect(String(calls[0]?.url)).toBe('/api/v1/topics/tp-1/images');
  expect(calls[0]?.init?.method).toBe('POST');
  const form = calls[0]?.init?.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  // 字段名写错（比如 file 写成 image）后端 readFormFile 会回 400 media.bad_type，而界面只会说「上传失败」
  expect(form.get('file')).toBeInstanceOf(Blob);
  // JSON 会被 content-type 写成 application/json，multipart 的 boundary 就没了
  expect(calls[0]?.init?.headers).toBeUndefined();
  // sort=0 就是列表封面（forum/pgsql/topics.go 取的就是它），这一条要能被调用方读到
  expect(out.sort).toBe(0);
});

it('删配图走 DELETE /topics/{id}/images/{hash}，路径参数要转义', async () => {
  const { calls } = mockFetch([{ status: 204 }]);
  await detachTopicImage('tp/1', 'a'.repeat(64));
  expect(String(calls[0]?.url)).toBe('/api/v1/topics/tp%2F1/images/' + 'a'.repeat(64));
  expect(calls[0]?.init?.method).toBe('DELETE');
});

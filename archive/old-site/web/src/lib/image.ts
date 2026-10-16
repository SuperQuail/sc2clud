// 图片工具：浏览器端压缩 + 上传（唯一实现，控件共用）
import { appUrl } from './paths'

/** 压缩到 targetBytes 以内：最长边 2560，WebP 质量阶梯。小图原样返回。 */
export async function compressImage(file: File, targetBytes: number): Promise<Blob> {
  if (file.size <= targetBytes) return file
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  let out: Blob = file
  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
    out = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/webp', quality))
    if (out.size <= targetBytes) break
  }
  return out
}

/** 上传一张图，返回可直接引用的地址（服务端返回 hash 或 url）。 */
export async function uploadImage(endpoint: string, csrf: string, file: Blob, name: string): Promise<string> {
  const form = new FormData()
  form.append('csrf', csrf)
  form.append('file', file, name.replace(/\.[^.]+$/, '.webp'))
  const res = await fetch(appUrl(endpoint), { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传失败（${res.status}）`)
  const data = (await res.json().catch(() => ({}))) as { url?: string; href?: string; hash?: string }
  const url = data.url ?? data.href ?? (data.hash ? `/img/${data.hash}` : '')
  if (!url) throw new Error('上传成功但没有拿到图片地址')
  return url
}

// 图片处理管线：**点选上传与拖拽走同一条路**（否则两处逻辑迟早不一致）。
// 限额与压缩的规则在这里，控件只负责触发。
export type PipelineOptions = {
  /** 已经有多少张 */
  existing: number;
  /** 上限（默认 10） */
  max?: number;
  /** 自动压缩（默认 true） */
  compress?: boolean;
  /** 本次是否上传原图 */
  useOriginal?: boolean;
  /** 单个文件的体积上限（不传按配图上限；头像位由控件传 AVATAR_MAX_BYTES） */
  maxBytes?: number;
  /** 本次选中的文件（体积判定要看它们）；不传就只按张数算 */
  files?: File[];
};

export type PipelinePlan = {
  /** 本次还能收几张 */
  room: number;
  /** 收到的文件里被丢弃的数量（超上限） */
  dropped: number;
  /** 因为**单个文件过大**被拒的第一个文件（没有就是 null） */
  tooBig: { name: string; size: number } | null;
};

const MAX_EDGE = 1600;
const QUALITY = 0.82;

// 体积上限（2026-10-13 补：此前只实现了张数上限，12MB 的图会被「最多 1 张」这种**张数文案**拒掉）。
// 两个值为什么不同：**服务端才是硬约束**（d1-platform.md §176，按路由设请求体上限 ——
// 头像 128KB、帖子配图 3MB），前端这两个数是「这条管线（压缩后）还救不救得动」的边界：
//   头像 10 MiB：手机原图常见的 3–8MB 都收得下，再用 canvas 压到 AVATAR_TARGET 提交（服务端只收 128KB）；
//   配图 20 MiB：压到长边 1600 的 WebP 后通常远小于 3MB。
// 超过就没必要让浏览器先解码几百 MB 的位图了 —— 当场拒掉并说清原因。
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const POST_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// 头像成品目标：前端架构设计-v1.md §7.4「头像：浏览器里压到 ≤ 64 KB 再上传，建议 256×256」。
// **触到目标就停**，所以正常图片不花这份钱；压不到（极复杂的图）也不报错，服务端还有 128KB 硬闸门 + 复核。
export const AVATAR_EDGE = 256;
export const AVATAR_TARGET = 64 * 1024;

/** 给人看的体积（1 位小数）：10485760 -> '10MB' */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + 'MB';
}

/** 纯计算：算这次能收几张、丢几张（可单测，不碰 DOM）。
 *  **体积先于张数判**：一张 12MB 的图塞进只收 1 张的头像位，要报「文件过大」，不是「最多 1 张」。
 *  过大的文件**不算占名额**（dropped 只数「装不下的正常图」），否则一张 12MB 的图会把后面能收的图挤掉。 */
export function planImages({ existing, max = 10, maxBytes = POST_IMAGE_MAX_BYTES, files = [] }: PipelineOptions): PipelinePlan {
  const room = Math.max(0, max - existing);
  const oversized = files.filter((f) => f.size > maxBytes);
  const taken = files.length - oversized.length;
  return { room, dropped: Math.max(0, taken - room), tooBig: oversized[0] ? { name: oversized[0].name, size: oversized[0].size } : null };
}

/** 压缩成 WebP（长边 1600、质量 0.82）；原图模式直接返回原文件 */
export async function processImage(file: File, opts: PipelineOptions & { maxEdge?: number; targetBytes?: number }): Promise<Blob> {
  if (opts.compress === false || opts.useOriginal) return file;
  const bitmap = await createImageBitmap(file);
  const edge = opts.maxEdge ?? MAX_EDGE;
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let quality = QUALITY;
  let out = await toWebp(canvas, quality);
  const target = opts.targetBytes;
  // 头像有明确成品目标（64KB），一次 0.82 大概率压不到；每轮降质量，仍不到就再缩一次长边
  if (target !== undefined && out.size > target) {
    for (let i = 0; i < 3 && out.size > target && quality > 0.4; i++) {
      quality = Math.max(0.4, quality - 0.18);
      out = await toWebp(canvas, quality);
    }
    if (out.size > target) {
      canvas.width = Math.max(1, Math.round(canvas.width * 0.7));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.7));
      out = await toWebp(canvas, quality);
    }
  }
  bitmap.close();
  return out;
}

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality)).then((b) => b ?? new Blob());
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const COMPRESS_LABEL = '已自动压缩（长边 ' + MAX_EDGE + '，WebP）';

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
};

export type PipelinePlan = {
  /** 本次还能收几张 */
  room: number;
  /** 收到的文件里被丢弃的数量（超出上限） */
  dropped: number;
};

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** 纯计算：算这次能收几张、丢几张（可单测，不碰 DOM） */
export function planImages(incoming: number, { existing, max = 10 }: PipelineOptions): PipelinePlan {
  const room = Math.max(0, max - existing);
  return { room, dropped: Math.max(0, incoming - room) };
}

/** 压缩成 WebP（长边 1600、质量 0.82）；原图模式直接返回原文件 */
export async function processImage(file: File, opts: PipelineOptions): Promise<Blob> {
  if (opts.compress === false || opts.useOriginal) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', QUALITY));
  bitmap.close();
  return blob ?? file;
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const COMPRESS_LABEL = '已自动压缩（长边 ' + MAX_EDGE + '，WebP）';

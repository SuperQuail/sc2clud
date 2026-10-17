import { api } from './client';

// media 域的**配图通道**（d5 §3.2）。2026-10-14 之前 `web/src/lib` 里**一个调用方都没有** ——
// 图文帖因此是半成品：上传端点绑在主题上、可见性固定 private、前端连函数都没写。
//
// 端点（`forum/internal/media/handler.go:50-53`，逐字）：
//   POST   /topics/{id}/images        multipart，字段名 `file`；201，回 AttachedImage
//   DELETE /topics/{id}/images/{hash} 204；归属判定在后端（别人的 404）
//
// 为什么绑在主题上：后端按 `topic_images(topic_id, post_id, image_hash, sort)` 记账，
// 而 sort=0 的那张就是**列表封面**的取图处（`forum/internal/forum/pgsql/topics.go:60`）——
// 所以第一张贴进去的配图自动成为封面，不需要第二个"设封面"的动作。
// 代价：**发新帖时还没有 topic id**，图片只能"先发帖、再回来配图"（编辑态）。
// 老站的通用 `POST /upload/image` 通道这里没有；要补就是另一块活，本轮不假造入口。

/** 一张已经附加到主题上的配图：`media/dto.go` 的 AttachedImage（hash / url / width / height / sort）。 */
export type AttachedImage = {
  hash: string;
  /** `/img/<hash>` 站根路径，当 src 用要过 `imagePath` */
  url: string;
  width: number;
  height: number;
  /** 0 就是封面（列表卡片取的那一张） */
  sort: number;
};

/**
 * 把一张图附加到主题上。
 *
 * multipart（字段名 `file`，与 `media/handler.go:170` 逐字一致）→ **不能**走 JSON，
 * 与头像 / 收款码同一条路。单图上限是服务端的 `image.post_max`（默认 2MiB），
 * 超了是 413 media.too_large（前端先压缩，别指望服务端放宽）。
 * 每帖最多 9 张，第 10 张回 400 media.limit_reached。
 */
export function attachTopicImage(topicId: string, file: Blob): Promise<AttachedImage> {
  const form = new FormData();
  form.append('file', file, 'image.webp');
  return api<AttachedImage>('topics/' + encodeURIComponent(topicId) + '/images', { method: 'POST', body: form });
}

/** 从主题上摘掉一张配图（引用计数同事务 −1）。hash 是 64 位小写 hex，路径里要转义。 */
export function detachTopicImage(topicId: string, hash: string): Promise<void> {
  return api<void>('topics/' + encodeURIComponent(topicId) + '/images/' + encodeURIComponent(hash), { method: 'DELETE' });
}

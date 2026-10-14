import { api, apiPage } from './client';
import { imagePath } from '@/lib/url';
import { pageQuery, type PageQuery } from './paging';
import type { Donation, UserBrief } from './admin-types';

// 打赏 / 赞助域（v2 §21.2 reward 段）。**字段名逐字照抄** `forum/internal/reward/dto.go`
// 与 `forum/internal/media/dto.go` 的 PaymentChannel，不照 DevRoom 的 mock 抄。
//
// 两条链路的作者侧写法（现行端点，均在 `reward/handler.go` 与 `media/handler.go` 里）：
//   · 收款码 CRUD 在 **media** 域：POST/GET /me/payment-channels、DELETE /me/payment-channels/{id}；
//   · 展示与申报在 **reward** 域：GET /users/{handle}/channels、POST /rewards、GET /me/rewards、
//     GET/PATCH /me/donation-settings。
// 2026-10-14 之前 `web/src/lib` 里**一个 reward/payment 客户端都没有**，所以这一整块是零接线。

/** 收款码渠道：id 是对外 uuid，image 是 `/img/<hash>`（**站根路径**，当 src 用要过 imagePath）。 */
export type PaymentChannel = {
  id: string;
  label: string;
  image: string;
  sort: number;
};

/** `GET /users/{handle}/channels`：作者开关关着时后端回**空数组**（不是 null）。 */
export async function fetchUserChannels(handle: string, signal?: AbortSignal): Promise<PaymentChannel[]> {
  const p = await apiPage<PaymentChannel>('users/' + encodeURIComponent(handle) + '/channels', { signal });
  return p.items;
}

/**
 * `POST /me/payment-channels` 是 **multipart**（字段名 `file`，与 `media/handler.go:170` 逐字一致），
 * 所以**不能**走 JSON —— 与 uploadAvatar 同一条路（`label` 是文本字段，空则后端回落「收款码」）。
 * 每用户上限 5 张（`media/service.go:39`），超了后端给 media.limit_reached。
 */
export function addPaymentChannel(file: Blob, label: string): Promise<PaymentChannel> {
  const form = new FormData();
  form.append('file', file, 'channel.png');
  form.append('label', label);
  return api<PaymentChannel>('me/payment-channels', { method: 'POST', body: form });
}

/** `DELETE /me/payment-channels/{id}` —— 归属判定在后端（别人的 404）。 */
export function deletePaymentChannel(id: string): Promise<void> {
  return api<void>('me/payment-channels/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 收款码里的图是 `/img/<hash>` 站根路径，渲染前统一过一层（dev 前缀下不过这层会拿到 SPA 的 HTML）。 */
export function channelImageSrc(c: PaymentChannel): string {
  return imagePath(c.image);
}

/** `POST /rewards` 的入参（`reward/dto.go` 的 CreateDonationInput）；IP 由后端从连接取，前端不发。 */
export type CreateDonationInput = {
  to_handle: string;
  amount_cents: number;
  txn_id?: string;
  post_id?: string;
  channel_id?: string;
  note?: string;
};

/** 申报一笔（**不是付款**：站点不经手资金，只有「用户自报 + 管理员人工核验」）。 */
export function createDonation(body: CreateDonationInput): Promise<Donation> {
  return api<Donation>('rewards', { method: 'POST', body });
}

/** `GET /me/rewards`：我发出的全部申报（**不过滤 state**，自己的当然看得到全部）。 */
export function fetchMyDonations(q: PageQuery = {}, signal?: AbortSignal): Promise<{ items: Donation[]; next: string | null }> {
  return apiPage<Donation>('me/rewards', { query: pageQuery(q), signal });
}

/** 撤回自己**还没核验**的申报（后端只动 pending；已核验的给 403）。 */
export function withdrawDonation(id: string): Promise<void> {
  return api<void>('rewards/' + encodeURIComponent(id), { method: 'DELETE' });
}

/**
 * `GET /users/{handle}/rewards`：**别人主页上的公开记录**，只 approved 且双方都同意公开
 * （逐行判：收款人开关管自己那侧，打赏人开关管自己那侧）。
 */
export function fetchUserDonations(handle: string, q: PageQuery = {}, signal?: AbortSignal): Promise<{ items: Donation[]; next: string | null }> {
  return apiPage<Donation>('users/' + encodeURIComponent(handle) + '/rewards', { query: pageQuery(q), signal });
}

/**
 * 本人的赞赏设置（`reward/dto.go` 的 DonationSettings，字段名三开关 + 文案，逐字一致）。
 * 旧站口径：**默认全关、提示开**；没有行时后端就回这个默认值。
 */
export type DonationSettings = {
  /** 在个人主页展示我的收款码（= 拍板说的「收款码可见性」那一档） */
  show_channels: boolean;
  /** 我的打赏记录可公开（逐行判：只影响「我作为打赏人」那侧） */
  records_public: boolean;
  notice_visible: boolean;
  notice_text: string;
};

export function fetchDonationSettings(signal?: AbortSignal): Promise<DonationSettings> {
  return api<DonationSettings>('me/donation-settings', { signal });
}

/** 部分字段更新：只发改过的键（后端是 `*bool` / `*string`，没传的保持原值）。 */
export function updateDonationSettings(patch: Partial<DonationSettings>): Promise<DonationSettings> {
  return api<DonationSettings>('me/donation-settings', { method: 'PATCH', body: patch });
}

/** 一条申报的展示态：`state` 四值与迁移 `ck_donation_records_state` 逐字一致。 */
export const DONATION_STATE: Record<string, string> = {
  pending: '待核验',
  approved: '已确认',
  rejected: '未通过',
  withdrawn: '已撤回',
};

export type { Donation, UserBrief };

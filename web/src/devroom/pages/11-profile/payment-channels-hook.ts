import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { isApiError } from '@/lib/api/errors';
import {
  addPaymentChannel,
  deletePaymentChannel,
  fetchDonationSettings,
  fetchMyChannels,
  updateDonationSettings,
  type DonationSettings,
} from '@/lib/api/rewards';

// 「赞赏与收款码」的数据侧（本人侧）。**两个宿主共用这一份**：
//   · 个人设置页那一格里就画（payment-channels.tsx 的 PaymentChannelsPanel）；
//   · 个人主页右栏那颗「设置我的收款码」就地弹层（D22，sponsor-card.tsx）。
// 分开写两份的话，同一件事（传一张码、开一个开关）会在两处各自漂移一次。
//
// 端点与字段名逐字照抄（不照 DevRoom 的 mock —— mock 里的 `qr_url` / 顶格 `notice` 后端都不存在）：
//   · POST/GET/DELETE /me/payment-channels（`media/handler.go:43-45`，上传是 multipart 字段 `file` + `label`）
//     —— **本人的码用这一条**，不用 reward 域那条 /users/{handle}/channels（它要过作者的展示开关）
//   · GET/PATCH /me/donation-settings（`reward/handler.go:41-42`，四个字段的部分更新）
//
// 每用户上限 5 张、单图 512KB 都是**服务端**的硬约束（`media/service.go:39` 与 config.Image.PaymentMax）。

/** 收款码是给人扫的：压缩到长边 256（头像位那一档）会糊掉码点，所以用配图位的 1600。 */
export const CHANNEL_MAX = 5;
/** 服务端的硬上限（config.Image.PaymentMax = 512KB），前端只能更小不能更大（超了是 413，用户看不出为什么）。 */
export const CHANNEL_BYTES = 512 * 1024;
/**
 * 交出去**之前**要压到的目标，留出 32KB 余量。
 *
 * 这里曾经把 CHANNEL_BYTES 直接当 maxSize 用 —— 那是「这一步收到的原图」的上限，
 * 于是 1.3MB 的收款码图在解压/压缩**之前**就被判「不能超过 0.5MB」当场退掉（D1）。
 * 上限与压缩目标是两个数：上限是「还救不救得动」（AVATAR_MAX_BYTES 那一档，与头像同一个道理），
 * 目标才是成品要压到多少。
 */
export const CHANNEL_TARGET = CHANNEL_BYTES - 32 * 1024;

/** 一行的提示：失败时说人话（后端 error.fields 已经在 message 里）。 */
function why(e: unknown, fallback: string): string {
  return isApiError(e) ? e.message : fallback;
}

/**
 * useMyPaymentChannels：本人收款码的取数与四个写动作。
 *
 * `enabled: false` = 这一屏不是本人（例如看别人的主页）：**一个请求都不发** ——
 * useQuery 的 enabled 管得住取数，但 useMutation 管不住，所以写动作也按它短路
 * （否则看别人主页时点一下某颗按钮就是一次注定 401/403 的往返）。
 */
export function useMyPaymentChannels(enabled = true) {
  const qc = useQueryClient();
  // 上传器给的体积/张数提示落在 View 上（宿主画，上传器内部不再画 —— D1 的「同一句提示出现两次」）
  const [notice, setNotice] = useState<string | null>(null);

  const channels = useQuery({
    queryKey: qk.paymentChannels(),
    queryFn: ({ signal }) => fetchMyChannels(signal),
    enabled,
  });
  const settings = useQuery({
    queryKey: qk.donationSettings(),
    queryFn: ({ signal }) => fetchDonationSettings(signal),
    enabled,
  });

  // 上传成功后**清掉提示**：预览换回服务端那张 /img/<hash>，别停在「本地已选」的假象上。
  const add = useMutation({
    mutationFn: (v: { file: Blob; label: string }) => addPaymentChannel(v.file, v.label),
    onSuccess: () => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: qk.paymentChannels() });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePaymentChannel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.paymentChannels() }),
  });
  // 部分更新：只发改过的那个键（后端是 *bool，多发一个键就是覆盖别人那一项）
  const saveSettings = useMutation({
    mutationFn: (patch: { show_channels?: boolean }) => updateDonationSettings(patch),
    onSuccess: (saved) => qc.setQueryData(qk.donationSettings(), saved),
  });

  return {
    channels: Array.isArray(channels.data) ? channels.data : [],
    channelsPending: channels.isPending,
    channelsError: channels.isError ? why(channels.error, '收款码读取失败') : null,
    // 还没读到设置（看别的主页 / 未登录）时不要编一份假的：View 按 undefined 走「正在读设置…」那一支
    settings: settings.data as DonationSettings | undefined,
    settingsPending: settings.isPending,
    settingsError: settings.isError ? '赞赏设置读取失败' : null,
    notice,
    setNotice,
    addError: add.isError ? why(add.error, '上传失败') : null,
    addPending: add.isPending,
    removeError: remove.isError ? '删除失败，请重试' : null,
    removePending: remove.isPending,
    saveError: saveSettings.isError ? why(saveSettings.error, '保存失败') : null,
    onAdd: (file: Blob, label: string) => {
      if (enabled) add.mutate({ file, label });
    },
    onDelete: (id: string) => {
      if (enabled) remove.mutate(id);
    },
    onShowChannels: (on: boolean) => {
      if (enabled) saveSettings.mutate({ show_channels: on });
    },
  };
}

import type { UserSummary } from '@/ui/user/user-badge';
import { sum } from './content';
import { USERS } from './users';
import type { AdminUser } from './core';

function u(username: string): AdminUser {
  const found = USERS.find((x) => x.username === username);
  if (!found) throw new Error('unknown user ' + username);
  return found;
}

// 打赏记录 = 申报单（DB §4.6 donation_records）。字段名与契约一致：amount_cents 是**整数分**。
export type RewardState = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export type RewardItem = {
  id: string; // public_id
  donor: UserSummary;
  recipient: UserSummary;
  amount_cents: number;
  txn_id: string;
  post_label: string | null;
  note: string;
  state: RewardState;
  created_at: string;
  channel: { id: string; name: string; image_hash: string };
  /** 收款人是否同意公开（records_public）：统计只累加 approved 且公开的 */
  records_public: boolean;
  verified_by: UserSummary | null;
  verified_at: string | null;
};

const CHANNELS = {
  alipay: { id: 'pc_1', name: '支付宝', image_hash: 'a3f1c9d2e5b74c8a91d0f6b2c7e4a1d9c3b8f5e2a7d4c1b9e6f3a8d5c2b7e4a1' },
  wechat: { id: 'pc_2', name: '微信', image_hash: '7d2b8e1f4a9c6b3d0e5f8a2c7b4d1e9f6a3c8b5d2e7f4a1c9b6d3e8f5a2c7b4d' },
};

export const REWARDS: RewardItem[] = [
  {
    id: 'rw_01', donor: sum(u('demo-zealot')), recipient: sum(u('demo-thor')), amount_cents: 5000, txn_id: '2026101222001456789',
    post_label: '【战役】《灰烬余晖》第三章发布，共 12 关', note: '第三章做得很用心，请继续。', state: 'pending',
    created_at: '2026-10-12T12:20:00Z', channel: CHANNELS.alipay, records_public: true, verified_by: null, verified_at: null,
  },
  {
    id: 'rw_02', donor: sum(u('demo-drone')), recipient: sum(u('demo-battlecruiser')), amount_cents: 1000, txn_id: '4200002210202610123456',
    post_label: '【资源】高清地形纹理包 v3（含夜间变体）', note: '', state: 'pending',
    created_at: '2026-10-12T10:02:00Z', channel: CHANNELS.wechat, records_public: true, verified_by: null, verified_at: null,
  },
  {
    id: 'rw_03', donor: sum(u('demo-hydralisk')), recipient: sum(u('demo-thor')), amount_cents: 20000, txn_id: '2026101109001234567',
    post_label: '【战役】《灰烬余晖》第二章发布', note: '之前说补的那笔。', state: 'pending',
    created_at: '2026-10-11T09:05:00Z', channel: CHANNELS.alipay, records_public: false, verified_by: null, verified_at: null,
  },
  {
    id: 'rw_04', donor: sum(u('demo-ghost')), recipient: sum(u('demo-voidray')), amount_cents: 1500, txn_id: '单号未填',
    post_label: null, note: '第一次打赏，不知道要不要填单号。', state: 'pending',
    created_at: '2026-10-11T01:30:00Z', channel: CHANNELS.wechat, records_public: true, verified_by: null, verified_at: null,
  },
  {
    id: 'rw_05', donor: sum(u('demo-zealot')), recipient: sum(u('demo-thor')), amount_cents: 5000, txn_id: '2026100512009876543',
    post_label: '【战役】《灰烬余晖》第二章发布', note: '', state: 'approved',
    created_at: '2026-10-05T12:10:00Z', channel: CHANNELS.alipay, records_public: true,
    verified_by: sum(u('demo-admin')), verified_at: '2026-10-05T13:00:00Z',
  },
  {
    id: 'rw_06', donor: sum(u('demo-drone')), recipient: sum(u('demo-battlecruiser')), amount_cents: 3000, txn_id: '4200002210202610051122',
    post_label: '【资源】高清地形纹理包 v2', note: '感谢教程。', state: 'approved',
    created_at: '2026-10-05T08:00:00Z', channel: CHANNELS.wechat, records_public: false,
    verified_by: sum(u('demo-overseer')), verified_at: '2026-10-05T09:30:00Z',
  },
  {
    id: 'rw_07', donor: sum(u('demo-hydralisk')), recipient: sum(u('demo-voidray')), amount_cents: 100000, txn_id: '0000000000000000000',
    post_label: null, note: '', state: 'rejected',
    created_at: '2026-10-04T15:00:00Z', channel: CHANNELS.alipay, records_public: true,
    verified_by: sum(u('demo-admin')), verified_at: '2026-10-04T16:20:00Z',
  },
  {
    id: 'rw_08', donor: sum(u('demo-zealot')), recipient: sum(u('demo-battlecruiser')), amount_cents: 2000, txn_id: '4200002210202610037788',
    post_label: null, note: '填错了金额，先撤回。', state: 'withdrawn',
    created_at: '2026-10-03T11:00:00Z', channel: CHANNELS.wechat, records_public: true, verified_by: null, verified_at: null,
  },
];

/** 打赏统计：**只算 approved 且 records_public=true**（DB §4.6 规则）。 */
export function rewardStats() {
  const counted = REWARDS.filter((r) => r.state === 'approved' && r.records_public);
  return {
    approved_total_cents: counted.reduce((s, r) => s + r.amount_cents, 0),
    approved_count: counted.length,
    pending_count: REWARDS.filter((r) => r.state === 'pending').length,
    rejected_count: REWARDS.filter((r) => r.state === 'rejected').length,
    withdrawn_count: REWARDS.filter((r) => r.state === 'withdrawn').length,
    hidden_count: REWARDS.filter((r) => r.state === 'approved' && !r.records_public).length,
  };
}

export const REWARD_STATE_LABEL: Record<RewardState, string> = {
  pending: '待核验', approved: '已通过', rejected: '已拒绝', withdrawn: '已撤回',
};
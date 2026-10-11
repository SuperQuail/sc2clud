-- ============================================================
-- 0031 打赏记录：用户提交、管理员验证、按被打赏人统计
--
-- 背景：作者已经能挂收款码（0013 payment_channels），钱由访客**直接**扫码
-- 付给作者，站点全程不经手资金。因此「这笔打赏是否真实」无法由站点自动核对，
-- 只做**人工验证**：用户自报金额与订单号，管理员核对后置为已验证。
--
-- 纯加法，可在生产安全执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS donation_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 打赏人（提交者）
    donor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 被打赏人（收款的作者）
    recipient_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 金额一律用**整数分**，绝不用浮点
    amount_cents   INTEGER NOT NULL,
    -- 订单号：可选，给人核对的凭据（各家规则不同，只限长度）
    txn_id         TEXT    NOT NULL DEFAULT '',
    -- 打赏发生时间（Unix 秒）
    paid_at        INTEGER NOT NULL,
    -- 这条打赏是在**哪篇帖子**下发生的。
    -- 帖子页打赏会带上；作者主页打赏没有帖子上下文，为 NULL。
    -- 帖子删除时置 NULL（记录本身要留着，钱是发生过的）。
    post_id        INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    -- pending 待验证 | approved 已验证 | rejected 未通过
    state          TEXT    NOT NULL DEFAULT 'pending',
    -- 管理员审核意见
    review_note    TEXT,
    reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    INTEGER,
    -- 结算：NULL = 尚未结算；仅对 approved 有意义
    settled_at     INTEGER,
    settlement_ref TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,

    -- 金额必须为正：0 与负数都是脏数据
    CHECK (amount_cents > 0),
    -- 不能给自己打赏
    CHECK (donor_id <> recipient_id),
    CHECK (state IN ('pending', 'approved', 'rejected'))
);

-- 按被打赏人统计（主页收入侧）：只查 approved 时走这条
CREATE INDEX IF NOT EXISTS idx_donation_recipient
    ON donation_records(recipient_id, state, paid_at DESC);
-- 按打赏人查（主页支出侧 / 我的记录）
CREATE INDEX IF NOT EXISTS idx_donation_donor
    ON donation_records(donor_id, state, paid_at DESC);
-- 管理端待审队列
CREATE INDEX IF NOT EXISTS idx_donation_queue
    ON donation_records(state, created_at);
-- 按帖子统计（「这篇帖子收到多少打赏」）
CREATE INDEX IF NOT EXISTS idx_donation_post
    ON donation_records(post_id, state, paid_at DESC);

-- 隐私开关：是否公开「我打赏了谁、多少钱」。
--
-- 与 0017 的 donation_visible **语义不同**（那是「是否展示我的收款码」），
-- 因此必须单独一列；复用会导致「关掉收款码展示 → 打赏记录一起消失」。
-- 默认关：涉及钱财，必须本人明确开启。
ALTER TABLE users ADD COLUMN donation_records_public INTEGER NOT NULL DEFAULT 0;

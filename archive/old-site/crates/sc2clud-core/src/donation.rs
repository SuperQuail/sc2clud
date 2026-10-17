//! 打赏记录：用户自查提交、管理员人工验证、按被打赏人统计。
//!
//! 与 [`crate::review`] 的 `ReviewState` 同构：状态机 + `as_str`/`label`/`parse` + 可见性判定。
//!
//! **本站不经手资金**：访客扫的是作者自己挂的收款码（0013 `payment_channels`），
//! 钱直接进作者口袋。所以这里的「验证」本质是**社会性**的 —— 用户自报金额与订单号，
//! 管理员核对后拍板。由此推出一条铁律：
//!
//! > 用户自报的数据不可信（同 `docs/ARCHITECTURE.md` §7「秒传不可信客户端」），
//! > **所有对外统计只认 `Approved`**，未验证的金额一律不进入任何聚合。

use crate::{Error, Result};

/// 单笔打赏上限（整数分）：10 万元。
///
/// 防误填（多打一个 0），不是业务限制。
pub const MAX_DONATION_CENTS: i64 = 10_000_000;

/// 订单号长度上限。各家支付平台的单号规则不同，只限长度、不限定格式。
pub const MAX_TXN_ID_CHARS: usize = 64;

/// 打赏时间下界：2025-01-01 00:00:00 UTC。早于它的按误填处理。
pub const MIN_PAID_AT: i64 = 1_735_689_600;

/// 允许的时钟偏移（秒）。
///
/// 表单是 `<input type="date">`，属于**日期粒度**：解析成 UTC 零点后，东八区
/// 用户在本地 08:00–24:00 之间选「今天」，那个零点其实还没到（最多差 8 小时）。
/// 给一天的容差换来「任何时区选今天都不会被拒」；代价是允许填到明天 ——
/// 对一个要人工审核的记账字段来说，这个代价值得。
const PAID_AT_SKEW_SECS: i64 = 86_400;

// ---------------------------------------------------------------- 状态机

/// 打赏记录的验证状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DonationState {
    /// 用户已提交，等管理员核对。
    Pending,
    /// 管理员核对通过 —— **只有这个状态计入统计与结算**。
    Approved,
    /// 管理员驳回（订单号对不上、金额不符、明显灌水）。
    Rejected,
}

impl DonationState {
    pub const ALL: [DonationState; 3] = [Self::Pending, Self::Approved, Self::Rejected];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "待验证",
            Self::Approved => "已验证",
            Self::Rejected => "未通过",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            other => Err(Error::InvalidInput(format!("未知的打赏状态：{other}"))),
        }
    }

    /// 审核态门槛：这条记录对查看者是否可见。
    ///
    /// - `Approved`：过审后对所有人可见（**是否真的公开还要再过一道隐私开关**，
    ///   见 `donation_records_public`）；
    /// - `Pending` / `Rejected`：只有提交者本人与管理员及以上可见。
    pub fn visible_to(self, is_owner: bool, is_staff: bool) -> bool {
        match self {
            Self::Approved => true,
            Self::Pending | Self::Rejected => is_owner || is_staff,
        }
    }

    /// 是否计入对外统计与结算。
    pub fn counts_toward_totals(self) -> bool {
        matches!(self, Self::Approved)
    }
}

// ---------------------------------------------------------------- 校验

/// 金额校验：必须为正，且不超过单笔上限。
pub fn validate_amount(cents: i64) -> Result<()> {
    if cents <= 0 {
        return Err(Error::InvalidInput("打赏金额必须大于 0".to_string()));
    }
    if cents > MAX_DONATION_CENTS {
        return Err(Error::InvalidInput(format!(
            "单笔打赏不能超过 {} 元",
            MAX_DONATION_CENTS / 100
        )));
    }
    Ok(())
}

/// 把用户填的金额文本解析成整数分。
///
/// 接受 `12` / `12.3` / `12.34` / `.5`；拒绝空串、负数、超过两位小数与任何非数字字符。
/// **绝不经过浮点**：`0.1 + 0.2` 那类误差在钱上不可接受。
pub fn parse_amount(raw: &str) -> Result<i64> {
    let s = raw.trim().trim_start_matches('¥').trim();
    if s.is_empty() {
        return Err(Error::InvalidInput("请填写打赏金额".to_string()));
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    if !int_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::InvalidInput("金额只能是数字".to_string()));
    }
    if !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::InvalidInput("金额只能是数字".to_string()));
    }
    if frac_part.len() > 2 {
        return Err(Error::InvalidInput("金额最多两位小数".to_string()));
    }
    if int_part.is_empty() && frac_part.is_empty() {
        return Err(Error::InvalidInput("请填写打赏金额".to_string()));
    }
    let yuan: i64 = if int_part.is_empty() {
        0
    } else {
        int_part
            .parse()
            .map_err(|_| Error::InvalidInput("金额超出可填范围".to_string()))?
    };
    let fen: i64 = match frac_part.len() {
        0 => 0,
        1 => frac_part.parse::<i64>().unwrap_or(0) * 10,
        _ => frac_part.parse::<i64>().unwrap_or(0),
    };
    let cents = yuan
        .checked_mul(100)
        .and_then(|v| v.checked_add(fen))
        .ok_or_else(|| Error::InvalidInput("金额超出可填范围".to_string()))?;
    validate_amount(cents)?;
    Ok(cents)
}

/// 金额格式化：`1234567` -> `¥12,345.67`。
pub fn format_amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.abs();
    let (yuan, fen) = (abs / 100, abs % 100);
    let digits = yuan.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (digits.len() - idx) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{sign}¥{grouped}.{fen:02}")
}

/// 订单号校验（可选字段）。返回去掉首尾空白后的值。
///
/// 只挡控制字符与超长，不限定格式 —— 支付宝/微信/爱发电的单号规则各不相同。
pub fn validate_txn_id(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.chars().count() > MAX_TXN_ID_CHARS {
        return Err(Error::InvalidInput(format!(
            "订单号最多 {MAX_TXN_ID_CHARS} 个字符"
        )));
    }
    if s.chars().any(char::is_control) {
        return Err(Error::InvalidInput("订单号包含非法字符".to_string()));
    }
    Ok(s.to_string())
}

/// 打赏时间校验：不能是未来，也不能早于站点上线。
pub fn validate_paid_at(paid_at: i64, now: i64) -> Result<()> {
    if paid_at > now + PAID_AT_SKEW_SECS {
        return Err(Error::InvalidInput("打赏时间不能晚于现在".to_string()));
    }
    if paid_at < MIN_PAID_AT {
        return Err(Error::InvalidInput(
            "打赏时间过早，请检查是否填错".to_string(),
        ));
    }
    Ok(())
}

/// 不能给自己打赏（数据库也有 CHECK，这里提前给出可读文案）。
pub fn validate_not_self(donor_id: i64, recipient_id: i64) -> Result<()> {
    if donor_id == recipient_id {
        return Err(Error::InvalidInput("不能给自己登记打赏记录".to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trip() {
        for state in DonationState::ALL {
            assert_eq!(
                DonationState::parse(state.as_str()).expect("可解析"),
                state,
                "{state:?} 往返失败"
            );
            assert!(!state.label().is_empty());
        }
        assert!(DonationState::parse("nope").is_err());
    }

    #[test]
    fn only_approved_counts_toward_totals() {
        assert!(DonationState::Approved.counts_toward_totals());
        assert!(!DonationState::Pending.counts_toward_totals());
        assert!(!DonationState::Rejected.counts_toward_totals());
    }

    #[test]
    fn pending_and_rejected_are_owner_or_staff_only() {
        for state in [DonationState::Pending, DonationState::Rejected] {
            assert!(state.visible_to(true, false), "本人应可见");
            assert!(state.visible_to(false, true), "管理员应可见");
            assert!(!state.visible_to(false, false), "陌生人不应可见");
        }
        assert!(DonationState::Approved.visible_to(false, false));
    }

    #[test]
    fn amount_parsing_has_no_float_error() {
        assert_eq!(parse_amount("12").unwrap(), 1200);
        assert_eq!(parse_amount("12.3").unwrap(), 1230);
        assert_eq!(parse_amount("12.34").unwrap(), 1234);
        assert_eq!(parse_amount(".5").unwrap(), 50);
        assert_eq!(parse_amount("  ¥8.88  ").unwrap(), 888);
        // 经典浮点陷阱：0.1 + 0.2 —— 用整数分就不可能出错
        assert_eq!(
            parse_amount("0.1").unwrap() + parse_amount("0.2").unwrap(),
            30
        );
    }

    #[test]
    fn amount_rejects_junk() {
        for bad in ["", "  ", "abc", "-5", "1.234", "1.2.3", "1e3"] {
            assert!(parse_amount(bad).is_err(), "{bad:?} 应被拒绝");
        }
        assert!(parse_amount("0").is_err(), "0 应被拒绝");
        assert!(parse_amount("0.00").is_err(), "0 应被拒绝");
    }

    #[test]
    fn amount_respects_upper_bound() {
        assert!(validate_amount(MAX_DONATION_CENTS).is_ok());
        assert!(validate_amount(MAX_DONATION_CENTS + 1).is_err());
    }

    #[test]
    fn amount_formatting_groups_thousands() {
        assert_eq!(format_amount(0), "¥0.00");
        assert_eq!(format_amount(5), "¥0.05");
        assert_eq!(format_amount(1234), "¥12.34");
        assert_eq!(format_amount(123456), "¥1,234.56");
        assert_eq!(format_amount(123456789), "¥1,234,567.89");
    }

    #[test]
    fn txn_id_is_optional_but_bounded() {
        assert_eq!(validate_txn_id("").unwrap(), "");
        assert_eq!(
            validate_txn_id("  2026101012345678  ").unwrap(),
            "2026101012345678"
        );
        assert!(validate_txn_id(&"x".repeat(MAX_TXN_ID_CHARS)).is_ok());
        assert!(validate_txn_id(&"x".repeat(MAX_TXN_ID_CHARS + 1)).is_err());
        assert!(validate_txn_id("bad\u{7}id").is_err());
    }

    #[test]
    fn paid_at_rejects_future_and_ancient() {
        let now = 1_800_000_000;
        assert!(validate_paid_at(now, now).is_ok());
        assert!(validate_paid_at(now - 86_400, now).is_ok());
        // 一天容差：东八区选「今天」时 UTC 零点还没到，必须放行
        assert!(
            validate_paid_at(now + 8 * 3600, now).is_ok(),
            "时区偏移内的「今天」不应被拒"
        );
        assert!(
            validate_paid_at(now + PAID_AT_SKEW_SECS + 1, now).is_err(),
            "超出容差的未来时间应被拒绝"
        );
        assert!(
            validate_paid_at(MIN_PAID_AT - 1, now).is_err(),
            "过早应被拒绝"
        );
    }

    #[test]
    fn cannot_donate_to_self() {
        assert!(validate_not_self(1, 2).is_ok());
        assert!(validate_not_self(1, 1).is_err());
    }
}

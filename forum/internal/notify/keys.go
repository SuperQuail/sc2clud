package notify

import "strconv"

// RefKey 是「一条内容」的唯一编码：ref_type:internal_id。
// 静音 target_key 与 dedup_key 的后半段都由它生成，写入与匹配必须走同一个函数（d4 §1.2）。
func RefKey(refType string, refID int64) string {
	return refType + ":" + strconv.FormatInt(refID, 10)
}

// DedupKey 是「同一次事件只产生一条通知」的幂等键（uq_notifications_user_dedup）。
func DedupKey(kind, refType string, refID int64) string {
	return kind + ":" + RefKey(refType, refID)
}

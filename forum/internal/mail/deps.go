package mail

import (
	"context"

	ent "forum/internal/ent"
	"forum/internal/platform/queue"
)

// Keys 是凭据主密钥（config.Mail 的两个字段，不新增配置项，d6 §5.5）。
// 空串 = 没配主密钥：进程照常启动，但**一封信都发不出去**（HasUsable=false，Send 返回 ErrPermanent）。
type Keys struct {
	KeyHex     string
	OldKeysHex string // 轮换期用，多个用逗号分隔
}

// Queue 是入队侧（platform/queue 的子集）：
//   - EnqueueTx 用于「建 mail_logs + 入队」同一事务（拍板 §5.4：事务里只能 EnqueueTx）；
//   - Enqueue 用于「额度用尽 → 重排到明天」这条事务外的重排（d6 §6.11）。
type Queue interface {
	Enqueue(ctx context.Context, t queue.Task) error
	EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
}

// Settings 是站点开关的只读视图，实现方是 internal/site。
// 本模块只读 mail.enabled（总开关）与 site.name（邮件落款）。
type Settings interface {
	Setting(ctx context.Context, key string) string
	SettingBool(ctx context.Context, key string) bool
}

package mail

import (
	"context"
	"encoding/json"
	"fmt"

	ent "forum/internal/ent"
	"forum/internal/mail/pgsql"
	pgmail "forum/internal/platform/mail"
	"forum/internal/platform/queue"
)

// EnqueueTx 是**别的模块投递邮件的唯一入口**：建 mail_logs 行 + 同事务入队 mail:send。
//
// 幂等键撞了唯一索引（同一封信被提交两次）时不新建、也不重复入队，直接复用既有那条 ——
// 这是「事务内重复提交」与「任务重试」共同的支点（uq_mail_logs_idem）。
func (s *Service) EnqueueTx(ctx context.Context, tx *ent.Tx, in EnqueueInput) error {
	id, created, err := s.insertLog(ctx, pgsql.NewTx(tx), in)
	if err != nil {
		return err
	}
	if !created {
		return nil
	}
	return s.q.EnqueueTx(ctx, tx, sendTask(id))
}

// SendVerifyCode 是 auth 的 Mailer 接口形状：**只建行、不入队**（auth 拿 id 自己入队，
// 它的入参里没有事务），返回 mail_logs.id。
//
// 幂等键用「模板 + 收件人 + 验证码」：重发会生成新码 → 新键 → 新行（旧码随之失效）；
// 万一同一用户又抽到同一串数字，那就是同一封信，复用旧行也正是对的（旧邮件里就是这串数字）。
func (s *Service) SendVerifyCode(ctx context.Context, userID int64, to, code, template string) (int64, error) {
	id, _, err := s.insertLog(ctx, s.pg, EnqueueInput{
		RecipientID:    userID,
		ToAddress:      to,
		Template:       template,
		Data:           pgmail.Data{Code: code},
		IdempotencyKey: fmt.Sprintf("%s:%d:%s", template, userID, code),
	})
	return id, err
}

// insertLog 建一条 pending 的投递记录；created=false 表示幂等键撞了（复用既有行）。
func (s *Service) insertLog(ctx context.Context, q *pgsql.Queries, in EnqueueInput) (int64, bool, error) {
	if err := checkEnqueue(in); err != nil {
		return 0, false, err
	}
	payload, err := json.Marshal(in.Data)
	if err != nil {
		return 0, false, fmt.Errorf("序列化邮件数据: %w", err)
	}
	return q.InsertLog(ctx, pgsql.NewLog{
		IdempotencyKey: in.IdempotencyKey,
		ToAddress:      in.ToAddress,
		Template:       in.Template,
		Payload:        payload,
		Now:            s.clk.Now(),
	})
}

// sendTask 是 mail:send 的入队形状：payload 只放 id（拍板 §5.7，不放业务快照）。
func sendTask(logID int64) queue.Task {
	return queue.Task{Type: queue.TypeMailSend, Payload: map[string]int64{"id": logID}}
}

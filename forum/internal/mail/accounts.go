package mail

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/mailaccount"
	"forum/internal/mail/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	platformdb "forum/internal/platform/db"
	"forum/internal/platform/idgen"
	pgmail "forum/internal/platform/mail"
)

// ListAccounts 是后台账号列表：**绝不回凭据**，只给需要的那几列 + 今日已发量。
func (s *Service) ListAccounts(ctx context.Context, actor *authz.Actor) ([]AdminAccount, error) {
	if err := requirePerm(actor, authz.PermMailManage); err != nil {
		return nil, err
	}
	rows, err := s.db.MailAccount.Query().
		Order(ent.Desc(mailaccount.FieldPriority), ent.Asc(mailaccount.FieldID)).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读发信账号: %w", err)
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	sent, err := s.pg.SentToday(ctx, ids, s.clk.Now())
	if err != nil {
		return nil, err
	}
	out := make([]AdminAccount, 0, len(rows))
	for _, r := range rows {
		out = append(out, accountView(r, sent[r.ID]))
	}
	return out, nil
}

// CreateAccount 建一个发信账号。凭据（明文 JSON）在这里加密后入库：
// AAD 用 public_id —— 与 platform/mail.Router 的解密 AAD 逐字一致（它读回时也用 public_id）。
func (s *Service) CreateAccount(ctx context.Context, actor *authz.Actor, in AccountInput) (*AdminAccount, error) {
	if err := requirePerm(actor, authz.PermMailManage); err != nil {
		return nil, err
	}
	if err := checkTZ(in.ResetTZ); err != nil {
		return nil, err
	}
	opts, err := jsonObject(in.Options, "options_json")
	if err != nil {
		return nil, err
	}
	secret, err := jsonObject(in.Secret, "secret")
	if err != nil {
		return nil, err
	}
	priority, limit := 0, 100
	if in.Priority != nil {
		priority = *in.Priority
	}
	if in.DailyLimit != nil {
		limit = *in.DailyLimit
	}
	if priority < 0 {
		return nil, apperr.Invalid(map[string]string{"priority": "不能为负"})
	}
	if limit < 1 {
		return nil, apperr.Invalid(map[string]string{"daily_limit": "必须大于 0"})
	}
	tz := in.ResetTZ
	if tz == "" {
		tz = defaultResetTZ
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	pid, err := idgen.NewPublicID()
	if err != nil {
		return nil, fmt.Errorf("生成账号 id: %w", err)
	}
	now := s.clk.Now()

	var cipher, nonce []byte
	var secretAt *time.Time
	if len(secret) > 0 {
		if s.crypter == nil {
			return nil, fmt.Errorf("mail: 没有可用的主密钥，不能保存凭据")
		}
		if cipher, nonce, err = s.crypter.Encrypt(secret, []byte(pid.String())); err != nil {
			return nil, fmt.Errorf("加密凭据: %w", err)
		}
		secretAt = &now
	}

	var out AdminAccount
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.MailAccount.Create().
			SetPublicID(pid).
			SetName(in.Name).
			SetProvider(in.Provider).
			SetPriority(priority).
			SetDailyLimit(limit).
			SetResetTz(tz).
			SetFromAddress(in.FromAddress).
			SetFromName(in.FromName).
			SetOptionsJSON(opts).
			SetSecretCipher(cipher).
			SetSecretNonce(nonce).
			SetNillableSecretUpdatedAt(secretAt).
			SetEnabled(enabled).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if isUniqueViolation(err) {
			return apperr.Invalid(map[string]string{"name": "账号名已存在"})
		}
		if err != nil {
			return fmt.Errorf("建发信账号: %w", err)
		}
		out = accountView(row, 0)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionAccountCreate,
			TargetType: "mail_account", TargetID: pid.String(),
			Detail: map[string]any{"after": map[string]any{
				"name": in.Name, "provider": in.Provider, "priority": priority,
				"daily_limit": limit, "enabled": enabled, "secret_configured": secretAt != nil,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateAccount 改优先级 / 额度 / 时区 / 发件人 / 开关 / 换凭据。**name 不可改**（d6 §6.10）。
func (s *Service) UpdateAccount(ctx context.Context, actor *authz.Actor, publicID string, in AccountPatch) (*AdminAccount, error) {
	if err := requirePerm(actor, authz.PermMailManage); err != nil {
		return nil, err
	}
	if in.ResetTZ != nil {
		if err := checkTZ(*in.ResetTZ); err != nil {
			return nil, err
		}
	}
	if in.Priority != nil && *in.Priority < 0 {
		return nil, apperr.Invalid(map[string]string{"priority": "不能为负"})
	}
	if in.DailyLimit != nil && *in.DailyLimit < 1 {
		return nil, apperr.Invalid(map[string]string{"daily_limit": "必须大于 0"})
	}
	opts, err := jsonObject(in.Options, "options_json")
	if err != nil {
		return nil, err
	}
	secret, err := jsonObject(in.Secret, "secret")
	if err != nil {
		return nil, err
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	now := s.clk.Now()

	var out AdminAccount
	var outID int64
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.MailAccount.Query().Where(mailaccount.PublicIDEQ(pid)).Only(ctx)
		if isNotFound(err) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("读发信账号: %w", err)
		}
		up := tx.MailAccount.UpdateOneID(row.ID).SetUpdatedAt(now)
		if in.Priority != nil {
			up = up.SetPriority(*in.Priority)
		}
		if in.DailyLimit != nil {
			up = up.SetDailyLimit(*in.DailyLimit)
		}
		if in.ResetTZ != nil {
			up = up.SetResetTz(*in.ResetTZ)
		}
		if in.FromAddress != nil {
			up = up.SetFromAddress(*in.FromAddress)
		}
		if in.FromName != nil {
			up = up.SetFromName(*in.FromName)
		}
		if len(opts) > 0 {
			up = up.SetOptionsJSON(opts)
		}
		if in.Enabled != nil {
			up = up.SetEnabled(*in.Enabled)
		}
		if len(secret) > 0 {
			if s.crypter == nil {
				return fmt.Errorf("mail: 没有可用的主密钥，不能轮换凭据")
			}
			cipher, nonce, err := s.crypter.Encrypt(secret, []byte(row.PublicID.String()))
			if err != nil {
				return fmt.Errorf("加密凭据: %w", err)
			}
			up = up.SetSecretCipher(cipher).SetSecretNonce(nonce).SetSecretUpdatedAt(now)
		}
		updated, err := up.Save(ctx)
		if err != nil {
			return fmt.Errorf("改发信账号: %w", err)
		}
		outID = updated.ID
		out = accountView(updated, 0)
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionAccountUpdate,
			TargetType: "mail_account", TargetID: pid.String(),
			// 凭据永远只写「配没配 + 什么时候换的」，明文与密文都不进审计
			Detail: map[string]any{"before": map[string]any{
				"priority": row.Priority, "daily_limit": row.DailyLimit, "enabled": row.Enabled,
				"secret_updated_at": row.SecretUpdatedAt,
			}, "after": map[string]any{
				"priority": updated.Priority, "daily_limit": updated.DailyLimit, "enabled": updated.Enabled,
				"secret_updated_at": updated.SecretUpdatedAt,
			}},
			IP: in.IP,
		})
	})
	if err != nil {
		return nil, err
	}
	sent, err := s.pg.SentToday(ctx, []int64{outID}, now)
	if err != nil {
		return nil, err
	}
	out.SentToday = sent[outID]
	return &out, nil
}

// DeleteAccount 删除：有 mail_logs 引用过就只归档（发信历史是证据，不因为删账号而消失，d6 §6.10）。
func (s *Service) DeleteAccount(ctx context.Context, actor *authz.Actor, publicID string) (*DeleteResult, error) {
	if err := requirePerm(actor, authz.PermMailManage); err != nil {
		return nil, err
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	now := s.clk.Now()
	out := &DeleteResult{}
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		row, err := tx.MailAccount.Query().Where(mailaccount.PublicIDEQ(pid)).Only(ctx)
		if isNotFound(err) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("读发信账号: %w", err)
		}
		referenced, err := pgsql.NewTx(tx).ReferencedByLogs(ctx, row.ID)
		if err != nil {
			return err
		}
		detail := map[string]any{}
		if referenced {
			if _, err := tx.MailAccount.UpdateOneID(row.ID).
				SetArchivedAt(now).SetEnabled(false).SetUpdatedAt(now).Save(ctx); err != nil {
				return fmt.Errorf("归档发信账号: %w", err)
			}
			out.Archived = true
			detail["archived_at"] = now
		} else {
			if err := tx.MailAccount.DeleteOneID(row.ID).Exec(ctx); err != nil {
				return fmt.Errorf("删发信账号: %w", err)
			}
			detail["deleted"] = true
		}
		return s.audit.Write(ctx, tx, audit.Entry{
			ActorID: actor.UserID, Action: actionAccountArchive,
			TargetType: "mail_account", TargetID: pid.String(),
			Detail: detail,
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SendTest 用指定账号给 in.To 发一封 test 模板的信：202 + mail_log_id。
//
// 它走 EnqueueTx（不直接发）：直接发会绕过额度账，并把 HTTP 超时变成 SMTP 超时（d6 §6.10）。
// 占额度：这次投递把 quota_account_id 预先绑到被测账号上，任务据此复用同一个账号。
func (s *Service) SendTest(ctx context.Context, actor *authz.Actor, publicID string, in SendTestInput) (*SendTestResult, error) {
	if err := requirePerm(actor, authz.PermMailManage); err != nil {
		return nil, err
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		return nil, apperr.ErrNotFound
	}
	row, err := s.db.MailAccount.Query().Where(mailaccount.PublicIDEQ(pid)).Only(ctx)
	if isNotFound(err) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读发信账号: %w", err)
	}
	if !row.Enabled || row.ArchivedAt != nil {
		return nil, apperr.Invalid(map[string]string{"account": "账号已停用或已归档，不能测试发信"})
	}
	if s.crypter == nil {
		s.log.Warn("mail: 主密钥不可用，测试发信失败", "account", row.Name)
		return nil, ErrSecretUndecryptable
	}
	if _, err := s.crypter.Decrypt(bytesOf(row.SecretCipher), bytesOf(row.SecretNonce), []byte(row.PublicID.String())); err != nil {
		s.log.Warn("mail: 账号凭据解不开，测试发信失败", "account", row.Name, "err", err.Error())
		return nil, ErrSecretUndecryptable
	}
	now := s.clk.Now()
	day, err := s.pg.QuotaDay(ctx, now, row.ResetTz)
	if err != nil {
		return nil, err
	}
	data := pgmail.Data{
		From: row.FromName + " <" + row.FromAddress + ">",
		Now:  now.Format(time.RFC3339),
	}
	var logID int64
	err = platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		txq := pgsql.NewTx(tx)
		id, created, err := s.insertLog(ctx, txq, EnqueueInput{
			RecipientID: actor.UserID, ToAddress: in.To, Template: TemplateTest, Data: data,
			// 每次点击都是一次新的测试：键里带纳秒时间戳，连点就发多封
			IdempotencyKey: fmt.Sprintf("test:%s:%d", row.PublicID, now.UnixNano()),
		})
		if err != nil {
			return err
		}
		logID = id
		if !created {
			return nil
		}
		if err := txq.BindQuota(ctx, id, row.ID, day, now); err != nil {
			return err
		}
		return s.q.EnqueueTx(ctx, tx, sendTask(id))
	})
	if err != nil {
		return nil, err
	}
	return &SendTestResult{MailLogID: logID}, nil
}

// accountView 把 ent 行转成后台 DTO。**凭据只以「配没配 + 什么时候换的」出现**。
func accountView(r *ent.MailAccount, sentToday int) AdminAccount {
	status := accountActive
	if r.ArchivedAt != nil {
		status = accountArchived
	}
	out := AdminAccount{
		ID: r.PublicID.String(), Name: r.Name, Provider: r.Provider,
		Priority: r.Priority, DailyLimit: r.DailyLimit, SentToday: sentToday,
		ResetTZ: r.ResetTz, FromAddress: r.FromAddress, FromName: r.FromName,
		Options: r.OptionsJSON, Enabled: r.Enabled, Status: status,
		SecretConfigured: len(bytesOf(r.SecretCipher)) > 0,
		SecretUpdatedAt:  r.SecretUpdatedAt,
		LastOKAt:         r.LastOkAt, LastErrorAt: r.LastErrorAt,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if r.LastError != nil {
		out.LastError = *r.LastError
	}
	return out
}

// bytesOf 把 ent 的可空 bytea 字段摊平：nil 与空切片在这里等价（都是「没配凭据」）。
func bytesOf(p *[]byte) []byte {
	if p == nil {
		return nil
	}
	return *p
}

// checkTZ 校验 IANA 名字：写进库的值一定要能被 time.LoadLocation 解析，
// 否则 Router 会静默跳过这个账号（表现是「邮件积压」，离原因很远）。
func checkTZ(tz string) error {
	if tz == "" {
		return nil
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return apperr.Invalid(map[string]string{"reset_tz": "不是合法的 IANA 时区名"})
	}
	return nil
}

// jsonObject 校验一个 JSON 字段是对象（或空）。凭据与 options 都只接受对象：
// 数组/标量会在 provider 构造时才炸，那时代码离错误的配置已经很远。
func jsonObject(raw json.RawMessage, field string) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, apperr.Invalid(map[string]string{field: "必须是 JSON 对象"})
	}
	return raw, nil
}

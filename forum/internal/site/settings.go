package site

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"sync/atomic"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	platformdb "forum/internal/platform/db"
	"forum/internal/site/pgsql"

	"forum/internal/authz"
)

// 站点设置键：字符串只写一遍，SettingSpecs 与站内读取都引用这些常量。
const (
	keySiteName     = "site.name"
	keySiteTagline  = "site.tagline"
	keySiteFooter   = "site.footer_note"
	keyRegisterOpen = "registration.open"
	keyAutoActivate = "auth.registration.auto_activate"
	keyReviewPolicy = "post.review_policy"
	keyDonationOn   = "donation.enabled"
	keyDonationText = "donation.notice_default"
	keyMailEnabled  = "mail.enabled"
	keyMailFromName = "mail.from_name"
	keyThreshold1   = "ai.review.report_threshold_1"
	keyThreshold2   = "ai.review.report_threshold_2"
	keyAIDailyLimit = "ai.review.daily_limit_per_topic"
	// AI 审核的**开关**进 site_settings（d7 §2.2）；模型/提示词/密钥属于 ai_config 表，不在这里。
	keyAIEnabled = "ai.review.enabled"
)

// 值域的写法（SettingSpec.Kind）。
const (
	kindText      = "text"
	kindMultiline = "multiline"
	kindToggle    = "toggle"
	kindSelect    = "select"
	kindInt       = "int"

	valueOn  = "on"
	valueOff = "off"
)

// maxSettingValueLen 是单个设置值的长度上限（d6 §6.7）。
const maxSettingValueLen = 2000

// SettingSpec 是一条站点设置的**声明**：类型、默认值、取值范围、说明。
//
// 这张表是站点设置键的唯一真源（d6 §5.4）：读写都按它校验，所以「未知 key」永远不会被静默写进库。
// **不在迁移里插默认行**（拍板 §12.2）：那会让默认值有两个真源，而这里的回落已经兜住了「表里没这行」。
type SettingSpec struct {
	Key     string
	Label   string
	Group   string // 站点 / 注册与审核 / 赞赏 / 邮件 / 内容审核
	Kind    string
	Options []string // 仅 select
	Min     int      // 仅 int
	Max     int      // 仅 int
	Default string
	Hint    string
}

// SettingSpecs 是全部站点设置（顺序即后台界面的顺序）。
func SettingSpecs() []SettingSpec {
	return []SettingSpec{
		{Key: keySiteName, Label: "站点名称", Group: "站点", Kind: kindText,
			Default: "SC2clud 战役作者社区", Hint: "出现在顶栏、分享卡片与邮件落款"},
		{Key: keySiteTagline, Label: "一句话简介", Group: "站点", Kind: kindText,
			Default: "", Hint: "首页与 <meta> 描述"},
		{Key: keySiteFooter, Label: "页脚文案", Group: "站点", Kind: kindMultiline,
			Default: "", Hint: "支持纯文本，换行保留"},
		{Key: keyRegisterOpen, Label: "开放注册", Group: "注册与审核", Kind: kindToggle,
			Default: valueOn, Hint: "关闭后只有管理员能建号"},
		{Key: keyAutoActivate, Label: "注册后自动激活（发验证码）", Group: "注册与审核", Kind: kindToggle,
			Default: valueOn, Hint: "打开 = 用户收到 6 位验证码后自助激活；关闭 = 用户注册后等管理员激活（拍板 §12.2）"},
		{Key: keyReviewPolicy, Label: "发帖审核策略", Group: "注册与审核", Kind: kindSelect,
			Options: []string{"untrusted", "all", "off"}, Default: "untrusted",
			Hint: "untrusted = 仅未标记 trusted 的作者进审核"},
		{Key: keyDonationOn, Label: "开放打赏", Group: "赞赏", Kind: kindToggle,
			Default: valueOn, Hint: "关闭后收款码与申报入口全站隐藏"},
		{Key: keyDonationText, Label: "打赏提示默认文案", Group: "赞赏", Kind: kindMultiline,
			Default: "如果这份战役帮到了你，可以扫码支持作者。站点不经手资金。",
			Hint:    "作者可覆盖；超管在这里配默认值"},
		{Key: keyMailEnabled, Label: "发信总开关", Group: "邮件", Kind: kindToggle,
			Default: valueOn, Hint: "关闭后注册验证与找回密码都不可用（危险）"},
		{Key: keyMailFromName, Label: "默认发信人名称", Group: "邮件", Kind: kindText,
			Default: "SC2clud", Hint: "账号级配置优先"},
		{Key: keyThreshold1, Label: "举报 → 复审阈值", Group: "内容审核", Kind: kindInt,
			Min: 1, Max: 50, Default: "3", Hint: "同一目标的未处理举报累计到这么多条 → 触发复核"},
		{Key: keyThreshold2, Label: "举报 → 直接转人工阈值", Group: "内容审核", Kind: kindInt,
			Min: 2, Max: 100, Default: "5", Hint: "累计到这么多 → 直接进人工队列（防举报风暴）"},
		{Key: keyAIDailyLimit, Label: "单帖每日 AI 调用上限", Group: "内容审核", Kind: kindInt,
			Min: 1, Max: 20, Default: "3", Hint: "同一篇主题一天最多调几次，防刷"},
		// d7 §2.2：AI 审核的开关在这里（模型与提示词在 ai_config 表，密钥只从 env 来）。
		{Key: keyAIEnabled, Label: "启用 AI 审核", Group: "内容审核", Kind: kindToggle,
			// d7 §2.2：默认 true —— 缺行回落声明默认（§12.2 不插默认行），写 off 等于全站按默认杀死 AI 审核。
			Default: valueOn, Hint: "与 ai_config.enabled 是「且」；关闭时一个外呼都不发"},
	}
}

// specs 是 SettingSpecs() 的索引。重复 key = 同一件事写了两遍 → 启动即红。
var specs = func() map[string]SettingSpec {
	m := make(map[string]SettingSpec, len(SettingSpecs()))
	for _, sp := range SettingSpecs() {
		if _, dup := m[sp.Key]; dup {
			panic("site: 站点设置键重复: " + sp.Key)
		}
		m[sp.Key] = sp
	}
	return m
}()

func specOf(key string) (SettingSpec, bool) {
	sp, ok := specs[key]
	return sp, ok
}

// check 校验一个值是否属于该键的值域；返回 "" 表示合法，否则是给用户看的一句话。
func (sp SettingSpec) check(v string) string {
	switch sp.Kind {
	case kindToggle:
		if v != valueOn && v != valueOff {
			return "只能是 on / off"
		}
	case kindSelect:
		if !slices.Contains(sp.Options, v) {
			return "取值不在允许范围内"
		}
	case kindInt:
		n, err := strconv.Atoi(v)
		if err != nil {
			return "必须是整数"
		}
		if n < sp.Min || n > sp.Max {
			return fmt.Sprintf("只能是 %d–%d 之间的整数", sp.Min, sp.Max)
		}
	}
	return ""
}

// settingsTTL 是整表缓存的存活时间（d6 §8.1；拍板 §12.2 允许 ≤30 秒的读缓存）。
const settingsTTL = 30 * time.Second

// settingsCache 是 site_settings 的进程内缓存：整表快照 + TTL。
//
// 实现就是一个 atomic.Value + 到期时间戳（拍板 §12.2 / d2 §10.1）：**不引入第二套缓存框架**，
// 十几行的只读快照也不需要 LRU —— 条目数恒等于键数。
// 缓存里存的是 **DB 原值**：默认值回落在 Setting 里做，否则「表里没这行」与「值就是默认值」会长得一样。
type settingsCache struct {
	vals   atomic.Value // map[string]string
	loaded atomic.Int64 // UnixNano；0 = 无缓存
}

func (c *settingsCache) get(now time.Time) (map[string]string, bool) {
	l := c.loaded.Load()
	if l == 0 || now.UnixNano()-l >= int64(settingsTTL) {
		return nil, false
	}
	v, _ := c.vals.Load().(map[string]string)
	return v, v != nil
}

func (c *settingsCache) put(now time.Time, vals map[string]string) {
	c.vals.Store(vals)
	c.loaded.Store(now.UnixNano())
}

// invalidate 丢弃缓存：后台写完立刻调，下一次读重新加载（TTL 只是多实例/漏调时的兜底）。
func (c *settingsCache) invalidate() { c.loaded.Store(0) }

// Setting 是**别的模块读站点开关的唯一入口**（不是直接查表）：全站只有这一份设置缓存。
//
// 缺行 / 空值 → 声明里的默认值；坏值 → 默认值 + Warn 一次；未声明的 key → 空串 + Warn 一次。
// 读失败（库抖了）也按默认值走：站点设置是开关，读不到它不该让整个请求 500。
func (s *Service) Setting(ctx context.Context, key string) string {
	sp, ok := specOf(key)
	if !ok {
		s.warnOnce(key, "未声明的站点设置键，按空串处理")
		return ""
	}
	vals, err := s.loadSettings(ctx)
	if err != nil {
		s.log.Warn("读站点设置失败，本次用默认值", "key", key, "err", err.Error())
		return sp.Default
	}
	raw, has := vals[key]
	if !has || raw == "" {
		return sp.Default
	}
	if msg := sp.check(raw); msg != "" {
		s.warnOnce(key, msg)
		return sp.Default
	}
	return raw
}

// SettingBool 读一个 toggle 键：只有 "off" 是假，缺行时按声明的默认值走。
func (s *Service) SettingBool(ctx context.Context, key string) bool {
	return s.Setting(ctx, key) == valueOn
}

// SettingInt 读一个 int 键。值域由声明兜住，所以返回值一定在 [Min, Max] 里；
// 未声明的 key 返回 0（调用方用的是 SettingSpecs 里的键，写错会在站点设置页面上直接看出来）。
func (s *Service) SettingInt(ctx context.Context, key string) int {
	if _, ok := specOf(key); !ok {
		return 0
	}
	n, err := strconv.Atoi(s.Setting(ctx, key))
	if err != nil {
		// 走不到：Setting 已按 Kind=int 校验过。真到了这里说明声明与实现不一致，值得一条日志
		s.warnOnce(key, "声明为 "+kindInt+" 但解析失败")
		return 0
	}
	return n
}

// warnOnce 让同一件事只 Warn 一次：Setting 在请求路径上（每个请求都可能读它），
// 而「这个键的值坏了」是同一个事实，每请求一条 Warn 只会把日志淹掉。
func (s *Service) warnOnce(key, msg string) {
	if _, dup := s.warned.LoadOrStore(key, struct{}{}); dup {
		return
	}
	s.log.Warn("站点设置不可用，按默认值处理", "key", key, "reason", msg)
}

func (s *Service) loadSettings(ctx context.Context) (map[string]string, error) {
	now := s.clk.Now()
	if v, ok := s.cache.get(now); ok {
		return v, nil
	}
	rows, err := s.pg.Settings(ctx)
	if err != nil {
		return nil, fmt.Errorf("读站点设置: %w", err)
	}
	vals := make(map[string]string, len(rows))
	for _, r := range rows {
		vals[r.Key] = r.Value
	}
	s.cache.put(now, vals)
	return vals, nil
}

// GetSettings 返回带 schema 的整表：后台按 kind 选控件，所以声明与值必须一起给。
func (s *Service) GetSettings(ctx context.Context, actor *authz.Actor) (*SettingsView, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	rows, err := s.pg.Settings(ctx)
	if err != nil {
		return nil, fmt.Errorf("读站点设置: %w", err)
	}
	stored := make(map[string]pgsql.SettingRow, len(rows))
	for _, r := range rows {
		stored[r.Key] = r
	}
	specList := SettingSpecs()
	out := &SettingsView{Items: make([]SettingItem, 0, len(specList))}
	for _, sp := range specList {
		item := SettingItem{
			Key: sp.Key, Label: sp.Label, Group: sp.Group, Kind: sp.Kind,
			Options: sp.Options, Value: sp.Default, Hint: sp.Hint,
		}
		if r, ok := stored[sp.Key]; ok {
			// 坏值显示成默认值：后台显示的必须是**生效值**，否则会出现「看到 A、实际按 B 跑」
			if r.Value != "" && sp.check(r.Value) == "" {
				item.Value = r.Value
			}
			updated := r.UpdatedAt
			item.UpdatedAt = &updated
		}
		out.Items = append(out.Items, item)
	}
	return out, nil
}

// UpdateSettings 是站点设置的唯一写入口（d6 §6.7）：**全验后写、单事务、每 key 一条审计**。
//
// 三条性质：未知 key / 坏值一个都不写（不会写一半）；多 key 要么全成要么全不成；
// 审计里每个 key 一行，before 是同一事务里读到的旧值（不存在 TOCTOU）。
func (s *Service) UpdateSettings(ctx context.Context, actor *authz.Actor, in SettingsInput) error {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return err
	}
	if len(in.Values) == 0 {
		return nil
	}

	fields := map[string]string{}
	for k, v := range in.Values {
		sp, ok := specOf(k)
		if !ok {
			fields[k] = "未知的站点设置键"
			continue
		}
		if len(v) > maxSettingValueLen {
			fields[k] = fmt.Sprintf("值过长（不超过 %d）", maxSettingValueLen)
			continue
		}
		if msg := sp.check(v); msg != "" {
			fields[k] = msg
		}
	}
	if len(fields) > 0 {
		return apperr.Invalid(fields)
	}

	// 排序后写：map 的迭代顺序随机，审计行的先后不该随机
	keys := slices.Sorted(maps.Keys(in.Values))
	now := s.clk.Now()
	err := platformdb.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		txq := pgsql.NewTx(tx)
		old, err := txq.SettingsByKeys(ctx, keys)
		if err != nil {
			return fmt.Errorf("读旧站点设置: %w", err)
		}
		for _, k := range keys {
			if err := txq.UpsertSetting(ctx, k, in.Values[k], now); err != nil {
				return err
			}
			if err := s.audit.Write(ctx, tx, audit.Entry{
				ActorID: actor.UserID, Action: actionSettingUpdate,
				TargetType: "site", TargetID: k,
				Detail: map[string]any{"before": old[k], "after": in.Values[k]},
				IP:     in.IP,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.cache.invalidate()
	return nil
}

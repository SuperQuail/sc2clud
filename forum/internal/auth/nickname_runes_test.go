package auth

import (
	"strings"
	"testing"
)

// 昵称长度的三处口径必须一致：
//   · users.nickname 是 varchar(20) —— Postgres 按**字符**计；
//   · 服务层 validateNickname 按 **rune** 计（account.go:34）；
//   · 而 ent 的 field.String().MaxLen(n) 校验的是**字节数**（ent@v0.14.6/schema/field/field.go:246）。
// 三处只有 ent 按字节，于是「7 个汉字」（7 字符 / 21 字节）通过服务层、被 ent 挡下，
// 用户看到的是 500「服务器错误」——2026-10-16 prod 实测：POST /api/v1/auth/register 500 ×6，
// 日志里全是 ent: validator failed for field "User.nickname": value is greater than the required length。
//
// 这两条用例把口径钉成**按字符**：7 个汉字合法、20 个汉字在边界内、21 个汉字是字段级 400。
func TestRegisterAcceptsCJKNicknameWithinRuneLimit(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	nick := strings.Repeat("好", 7) // 7 字符 = 21 字节；按字符算远在 20 之内
	if _, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "runelen", Email: "runelen@example.com", Password: "passw0rd-1",
		Nickname: nick, IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("7 个汉字的昵称应当合法（7 ≤ 20 字符），实际被拒：%v", err)
	}
	var stored string
	if err := f.pool.QueryRow(f.ctx, "SELECT nickname FROM users WHERE username = 'runelen'").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != nick {
		t.Fatalf("落库昵称 = %q，想要 %q", stored, nick)
	}
}

func TestRegisterNicknameRuneLimitBoundary(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	if _, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "runelen20", Email: "runelen20@example.com", Password: "passw0rd-1",
		Nickname: strings.Repeat("好", 20), IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("20 个汉字正好在下限内，应当通过，实际被拒：%v", err)
	}
	_, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "runelen21", Email: "runelen21@example.com", Password: "passw0rd-1",
		Nickname: strings.Repeat("好", 21), IP: "127.0.0.1",
	})
	if err == nil {
		t.Fatal("21 个汉字的昵称应当被拒")
	}
	if got := errCode(err); got != "common.invalid_input" {
		t.Fatalf("错误码 = %q，想要 common.invalid_input（字段级 400，而不是 500）", got)
	}
}

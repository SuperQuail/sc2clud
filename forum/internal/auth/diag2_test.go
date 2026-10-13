package auth

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
)

func TestDiagSession2(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("diag", "passw0rd-1", "user")

	tok, dig, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(tok))
	t.Logf("newToken 自洽: %v", bytes.Equal(sum[:], dig))
	t.Logf("digestOf(tok) == newToken 的 dig: %v", bytes.Equal(digestOf(tok), dig))

	out, err := f.svc.Login(f.ctx, LoginInput{Login: "diag", Password: "passw0rd-1", IP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	sdb := stdlib.OpenDBFromPool(f.pool)
	defer sdb.Close()
	var fromDB []byte
	if err := sdb.QueryRowContext(f.ctx, "SELECT token_hash FROM sessions").Scan(&fromDB); err != nil {
		t.Fatal(err)
	}
	computed := sha256.Sum256([]byte(out.Token))
	t.Logf("库里  =%x", fromDB)
	t.Logf("token sha=%x", computed)
	t.Logf("相等=%v  token len=%d", bytes.Equal(fromDB, computed[:]), len(out.Token))
	t.Logf("token=%q", out.Token)
}

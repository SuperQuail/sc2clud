package auth

import "testing"

// 不变量：newToken 返回的摘要必须等于 digestOf(它返回的 token)。
// Cookie 里只有串，服务端每次都从串重算——两处输入不一致就会让「刚登录的会话解析不出来」。
func TestNewTokenDigestMatches(t *testing.T) {
	for i := 0; i < 5; i++ {
		tok, dig, err := newToken()
		if err != nil {
			t.Fatal(err)
		}
		if len(tok) != 43 {
			t.Fatalf("token 长度 %d，想要 43（32 字节 base64url 无填充）", len(tok))
		}
		if len(dig) != 32 {
			t.Fatalf("摘要长度 %d，想要 32", len(dig))
		}
		if string(dig) != string(digestOf(tok)) {
			t.Fatal("newToken 的摘要与 digestOf(token) 不一致")
		}
	}
}

// 摘要只认串：同一个 token 两次算出来必须一样（它就是解析路径的查找键）。
func TestDigestOfIsStable(t *testing.T) {
	tok, _, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	if string(digestOf(tok)) != string(digestOf(tok)) {
		t.Fatal("digestOf 不稳定")
	}
}

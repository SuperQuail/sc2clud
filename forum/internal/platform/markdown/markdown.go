// Package markdown 把用户提交的 Markdown 渲染成可以安全展示的 HTML。
//
// 流水线（顺序不能变，v2 §9.7 / 拍板 §8.4）：
//
//	goldmark → bluemonday.UGCPolicy() → 在 DOM 层按 href 前缀改写 mention: 链接
//
// **为什么改写放在清洗之后**：m_test.go 第一步就验证了 UGCPolicy 会把 <a href="mention:123">
// 的 href 整个丢掉（href 没了就无从改写），所以策略里显式放行 mention: 这一个协议
// （只放行它，javascript: / data: 仍然被丢）。清洗之后再改写，最终 HTML = 已清洗的树 + 我们自己
// 写出的 href 与文本；改写只产出 /u/<数字> 与转义后的昵称，不引入任何用户可控的标签或属性。
//
// 被否掉的路：goldmark 渲染钩子里改写——钩子拿不到渲染后的树，改写后还得再过一次清洗；
// 而「出 HTML 后在 DOM 层按 href 前缀改写」正是拍板 §8.4 点名的做法。
package markdown

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// renderer 是唯一的渲染器实例。WithUnsafe 允许正文里的原始 HTML 进来——它随后要过 bluemonday，
// 放开这一层换的是「<br>、<details> 这类排版标签能用」；清洗仍是唯一出口。
var renderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

// policy 是清洗策略：UGCPolicy + 放行 mention: 这一个协议（理由见包注释）。
var policy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowURLSchemes("mention")
	return p
}()

// Render 渲染并清洗 Markdown，同时把 [@昵称](mention:<id>) 改写成
// <a href="/u/<id>" data-mention="<id>">@<当前昵称></a>。
//
// names 是「id → 当前昵称」的现取映射（渲染时 join users）：
//   - 命中：显示当前昵称（用户改过名就显示新名）；
//   - 未命中：用链接文本里的昵称快照（写这条正文时的名字，用户已注销时兜底）；
//   - 链接文本为空：只留一个纯文本 @（不留指向 /u/0 的死链）。
func Render(source string, names map[int64]string) (string, error) {
	var buf bytes.Buffer
	if err := renderer.Convert([]byte(source), &buf); err != nil {
		return "", err
	}
	return rewriteMentions(policy.Sanitize(buf.String()), names)
}

// mentionPrefix 是存储格式里的协议前缀：[@昵称](mention:123) 渲染成 <a href="mention:123">@昵称</a>。
// 改写只认这个前缀，不做字符串替换（拍板 §8.4）。
const mentionPrefix = "mention:"

// rewriteMentions 在 DOM 层改写。
//
// 解析的是**已经清洗过**的 HTML：解析不引入新标签，我们只动 a 的 href、data-mention 与文本。
// 回写用同一个 html.Node 树，不重新拼 HTML 字符串。
func rewriteMentions(clean string, names map[int64]string) (string, error) {
	// ParseFragment 而不是 Parse：正文是一个片段，不需要凑出 <html><head><body> 再拆掉，
	// 也就不会出现「渲染结果比输入多一层壳」这种往返差异。
	nodes, err := nethtml.ParseFragment(strings.NewReader(clean), &nethtml.Node{
		Type: nethtml.ElementNode, Data: "body", DataAtom: atom.Body,
	})
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	for _, n := range nodes {
		walk(n, names)
		if err := nethtml.Render(&out, n); err != nil {
			return "", err
		}
	}
	return out.String(), nil
}

func walk(n *nethtml.Node, names map[int64]string) {
	if n.Type == nethtml.ElementNode && n.DataAtom == atom.A && rewriteLink(n, names) {
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walk(c, names)
	}
}

// rewriteLink 判断一个 <a> 是不是提及；是就地改写并返回 true。
func rewriteLink(a *nethtml.Node, names map[int64]string) bool {
	id, ok := mentionID(attr(a, "href"))
	if !ok {
		return false
	}
	name := names[id]
	if name == "" {
		// 当前昵称没查到（已注销 / 查询漏了）：用写入时的昵称快照，去掉链接文本前面的 @。
		name = strings.TrimPrefix(snapshot(a), "@")
	}
	num := strconv.FormatInt(id, 10)
	// 重建属性表：href 换成站内地址，去掉清洗策略给外链加的 rel="nofollow"
	// （/u/<id> 是站内链接，加 nofollow 只是噪音），再挂上 data-mention。
	attrs := make([]nethtml.Attribute, 0, len(a.Attr)+1)
	for _, att := range a.Attr {
		switch att.Key {
		case "href":
			attrs = append(attrs, nethtml.Attribute{Key: "href", Val: "/u/" + num})
		case "rel":
		default:
			attrs = append(attrs, att)
		}
	}
	a.Attr = append(attrs, nethtml.Attribute{Key: "data-mention", Val: num})

	// 链接文本换成 @ + 昵称；名字为空就只留 @。
	setText(a, "@"+name)
	return true
}

// mentionID 从 href 里取 user_id；不是提及链接就返回 false。
// 只接受纯数字（<=18 位、不以 0 开头），所以 href 里不可能夹进别的东西。
func mentionID(href string) (int64, bool) {
	rest, ok := strings.CutPrefix(href, mentionPrefix)
	if !ok || rest == "" || len(rest) > 18 || rest[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(rest); i++ {
		if rest[i] < '0' || rest[i] > '9' {
			return 0, false
		}
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

// attr 取属性值；没有就返回空串。
func attr(n *nethtml.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// snapshot 是一条提及链接当前的文本（写入时的昵称快照，形如 "@昵称"）。
// 按空白切分再拼：换行/制表符不该出现在展示文本里。
func snapshot(a *nethtml.Node) string {
	var b strings.Builder
	for c := a.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == nethtml.TextNode {
			b.WriteString(c.Data)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// setText 把节点内容换成单个文本子节点（文本本身含 @ 与昵称，渲染时会被转义）。
func setText(n *nethtml.Node, text string) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		n.RemoveChild(c)
		c = next
	}
	n.AppendChild(&nethtml.Node{Type: nethtml.TextNode, Data: text})
}

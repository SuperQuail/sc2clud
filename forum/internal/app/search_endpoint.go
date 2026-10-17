package app

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
	"forum/internal/platform/search"
)

const maxSearchLimit = 20

// 搜索游标**不是**列表那套 (时间, id)：搜索按 (rank DESC, id DESC) 排，而 rank 由档位算出来，
// 翻页时**必须把档位一起带回来** —— loose 的 rank 分布与 exact 不同，喂错档位就是错序结果
// （platform/search/pgsql 的注释写明）。所以游标自带 rank + tier，前端只原样带回、不解析。
type searchCursor struct {
	K string `json:"k"` // rank，字符串化的 float32（避开 JSON 浮点误差）
	I int64  `json:"i"` // 主题内部 id（不出 API，只在游标里）
	T string `json:"t"` // exact | loose
}

func encodeSearchCursor(p search.Page) string {
	if p.NextCursorRank == nil || p.NextCursorID == nil {
		return ""
	}
	b, err := json.Marshal(searchCursor{
		K: strconv.FormatFloat(float64(*p.NextCursorRank), 'g', -1, 32),
		I: *p.NextCursorID,
		T: string(p.Tier),
	})
	if err != nil { // 结构体固定，序列化不会失败；真失败就当作到底，而不是发一个坏游标
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeSearchCursor(s string) (float32, int64, search.Tier, error) {
	bad := apperr.New("common.invalid_input", 400, "游标无效")
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, 0, "", bad
	}
	var c searchCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return 0, 0, "", bad
	}
	r, err := strconv.ParseFloat(c.K, 32)
	if err != nil {
		return 0, 0, "", bad
	}
	if c.T != string(search.TierExact) && c.T != string(search.TierLoose) {
		return 0, 0, "", bad
	}
	return float32(r), c.I, search.Tier(c.T), nil
}

// searchEndpoint 是 `GET /api/v1/search?q=&type=topics|users&limit=&cursor=`。
//
// **为什么它在 app 层**：一个端点横跨两个域 —— type=topics 归 forum（卡片形状与 platform/search 都在那边），
// type=users 归 user（与 /users/search 共用同一份查询，不在这里复制第二份用户形状）。
// app 是「唯一认识所有域的地方」，跨域组合正是它存在的理由。
//
// 2026-10-13：查询侧（SearchTopics 两档 exact/loose、游标、以及「不泄露隐藏/待审」的测试）
// 与 user.Search 一直都在，**缺的只是这条路由** —— 于是 /api/v1/search 落到 SPA 兜底返回 200 + HTML，
// 前端只能摆一个「搜索还没接后端」的占位页。
func (m *Modules) searchEndpoint(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		httpx.Fail(c, apperr.New("common.invalid_input", 400, "搜索词不能为空"))
		return
	}
	limit := 10
	if n, err := strconv.Atoi(c.Query("limit")); err == nil && n > 0 {
		limit = min(n, maxSearchLimit)
	}
	ctx := c.Request.Context()

	switch c.DefaultQuery("type", "topics") {
	case "topics":
		in := search.Query{Tokens: search.Tokenize(q), Limit: limit}
		if cur := c.Query("cursor"); cur != "" {
			rank, id, tier, err := decodeSearchCursor(cur)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			in.CursorRank, in.CursorID, in.Tier = &rank, &id, tier
		}
		page, err := m.searchIndex().SearchTopics(ctx, in)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		ids := make([]int64, 0, len(page.Hits))
		for _, h := range page.Hits {
			ids = append(ids, h.TopicID)
		}
		cards, err := m.Forum.TopicCards(ctx, ids)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OKList(c, cards, encodeSearchCursor(page))
	case "users":
		items, err := m.User.Search(ctx, q, limit)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, items)
	default:
		// **不静默当成 topics**：那样用户以为在搜人，其实在看帖子。
		httpx.Fail(c, apperr.New("common.invalid_input", 400, "type 只能是 topics 或 users"))
	}
}

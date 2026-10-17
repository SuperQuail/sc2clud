package search

import "context"

// Hit 是一条搜索命中。标题与 id 由本包给出，作者/计数由调用方按 id 批量补全（d5 §6.6）。
type Hit struct {
	TopicID  int64
	PublicID string
	Title    string
	Rank     float32
}

// Tier 是查询档位：exact = 全部词素 AND；loose = 只用单字词素 OR。
// 空值表示「由 Searcher 自己决定」——先跑 exact。
type Tier string

const (
	TierExact Tier = "exact"
	TierLoose Tier = "loose"
)

// Query 是一次搜索请求。游标 (CursorRank, CursorID) 与排序键 (rank DESC, id DESC) 同序，
// 翻页时减半开区间取 (rank, id) < (cursorRank, cursorID)。
type Query struct {
	Tokens     string // = Tokenize(q)，索引与查询共用同一个分词器
	BoardID    *int64 // 可选分区筛选
	Tier       Tier   // 空 = 先 exact；翻页时把上一页的 tier 原样带回
	CursorRank *float32
	CursorID   *int64
	Limit      int
}

// Page 是一页结果。NextCursor 为空表示到底；Tier 是**实际**用的档位，翻页时必须带回。
type Page struct {
	Hits           []Hit
	Tier           Tier
	NextCursorRank *float32
	NextCursorID   *int64
}

// TopicDoc 是索引写入的全部输入。tokens 已由调用方用 Tokenize 算好，
// 这里不重算：写入侧与查询侧同一个函数这件事，必须在调用点上看得见。
type TopicDoc struct {
	TopicID  int64
	Title    string
	BodyText string
	Tokens   string
}

// Searcher 只回答「哪些主题命中了」；可见性与审核态的过滤在 SQL 里（d5 §6.6）。
// 两档（先 exact，首页 0 行才 loose）由实现内部决定，调用方只负责把 Tier 带回来。
type Searcher interface {
	SearchTopics(ctx context.Context, q Query) (Page, error)
}

// Indexer 是索引写入侧。两个方法都必须幂等：队列是至少一次投递。
type Indexer interface {
	UpsertTopic(ctx context.Context, doc TopicDoc) error
	DeleteTopic(ctx context.Context, topicID int64) error
}

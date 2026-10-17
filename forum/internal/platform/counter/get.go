package counter

// Get 读缓冲里还没写库的增量。列表与详情要用**同一个和**（forum/map.go：ViewCount +
// Get(键)），否则两个页面上的数字对不上。
//
// 接线时补：本包原来只有 Add，而 forum.Deps.Counter 要的是 Add + Get。
func (b *Buffer) Get(key string) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.m[key]
}

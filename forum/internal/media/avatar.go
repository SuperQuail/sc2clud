package media

import "context"

// Avatar 是 user 域 AvatarURL 的实现（U12/U15/U20）：本模块是 /img/<hash> 的**唯一**拼接点，
// 所以「hash → 路径」这件事不在 user 域再写一遍。
//
// 取值优先级与前端约定一致：本人设过头像就用它；没设过用分发到的默认头像；都没有给空串
// （前端显示首字母占位）。userID 只用于将来按用户分流，本实现不读它。
// Cover 是 user 域 AvatarURL 的第二个方法：封面与头像是同一条图片读路径（/img/{hash}），
// 所以拼接点也只有这一个地方。空 hash 给空串（前端按「没设过」走默认站内素材）。
func (s *Service) Cover(hash string) string { return urlOf(hash) }

func (s *Service) Avatar(_ context.Context, _ int64, hash, smallHash, defaultHash string) (string, string) {
	avatar, small := urlOf(hash), urlOf(smallHash)
	if avatar == "" {
		avatar = urlOf(defaultHash)
	}
	if small == "" {
		small = avatar // 没有小图时用同一张：头像位不能空一半
	}
	return avatar, small
}

package mention

import (
	"fmt"

	"forum/internal/platform/apperr"
)

// ErrBadMention 是「提及的用户不存在 / 被封禁 / 超上限」的唯一错误码（v2 §9.7、d4 §5.6）。
var ErrBadMention = apperr.New("content.bad_mention", 400, "提及的用户不存在")

// CheckLimit 校验单条正文的提及数。
func CheckLimit(ids []int64) error {
	if len(ids) > MaxPerBody {
		return ErrBadMention.WithMsg(fmt.Sprintf("一条正文最多 @%d 个人", MaxPerBody))
	}
	return nil
}

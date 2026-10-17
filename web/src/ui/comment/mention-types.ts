// @ 提及的候选项形状。真实实现来自 `GET /api/v1/users/search?q=`（按昵称前缀 + username）。
// `duplicate` 是需求里要求的「重名标记」。
export type MentionCandidate = {
  /** users.id —— 提及的**唯一真源**（见后端方案 §9 的契约） */
  id: string;
  nickname: string;
  handle: string;
  avatar?: string | null;
  role?: { key: string; name: string } | null;
  /** 与其它候选昵称相同 */
  duplicate?: boolean;
};

import { api } from './client';

// 头衔域（forum/internal/title/handler.go 的五条路由）。前端只用得到这三条：
//   GET  /users/{handle}/titles → { items, equipped_id }   某人**持有**的全部 + 当前佩戴（公开读）
//   GET  /titles                → TitleDTO[]               目录（不返回归档的）
//   PUT  /me/title              → 204                      佩戴 / 卸下（"" 或 null = 不佩戴）
//
// **字段名逐字照 title.TitleDTO**（forum/internal/title/types.go:29-36）：
// id（public_id —— PUT 的 title_id 要的就是它）/ key / name / color / description / archived_at。
// 「佩戴中的那一个」在 user.Profile 里另有一份精简的 { name, color }（没有 id），
// 所以「我是谁、我戴的是哪一个」必须读 /users/{handle}/titles 的 equipped_id，不能从 Profile 推。
export type Title = {
  id: string;
  key: string;
  name: string;
  color: string;
  description: string;
  archived_at: string | null;
};

export type UserTitles = {
  items: Title[];
  /** "" = 未佩戴（后端 UserTitlesDTO.EquippedID 的原话） */
  equipped_id: string;
};

export function fetchUserTitles(handle: string, signal?: AbortSignal): Promise<UserTitles> {
  return api<UserTitles>('users/' + encodeURIComponent(handle) + '/titles', { signal });
}

/** 佩戴一个头衔（id = TitleDTO.id）；null = 卸下。后端回 204，没有回执体 —— 读回以 GET 为准。 */
export function equipTitle(titleId: string | null): Promise<void> {
  // 卸下发**空串**而不是 null：handler 的 equipBody.TitleID 是 *string，两条路都通（title.Equip 判的是
  // "" 那一条），但发字符串让「这个字段永远是字符串」在线上只有一种形状 —— 少一处要靠人对齐的隐式约定。
  return api<void>('me/title', { method: 'PUT', body: { title_id: titleId ?? '' } });
}

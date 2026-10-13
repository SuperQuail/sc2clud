import { z } from 'zod';

// 响应包络与错误体（前端方案 §5.1，与后端 §14.4 / v2 §21.1 逐字对齐）。
// 契约的真源是后端各模块的 dto.go；这里是前端侧的复述，两边一致性由 v2 §21.6 的契约测试盯住。
// **只有包络在这里**：业务实体暂不写第二份 zod 复述 —— 类型由 lib/api/*.ts 按 §21.3 的示例声明，
// 逐字段 zod 化要在 §21.6 契约测试落地时才有校验价值（现在写了也没人跑，等于两份会漂移的真源）。

/** 成功包络：{ "data": … }；列表额外带 next_cursor（为 null 表示到底） */
export const envelope = z.object({ data: z.unknown() });

/** { "data": [...], "next_cursor": "…" | null } */
export const pageEnvelope = z.object({
  data: z.array(z.unknown()),
  next_cursor: z.string().nullable(),
});

export const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type Page<T> = { data: T[]; next_cursor: string | null };

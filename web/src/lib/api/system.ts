import { BASE } from '@/lib/base';
import { api } from './client';

// 探针不带 /api/v1 前缀（后端方案 21.1）
export type Health = { status: string; version: string };

export function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return api<Health>('healthz', { base: BASE, signal });
}

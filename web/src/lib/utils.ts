import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn 的标准工具函数：类名合并（后写的赢）
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

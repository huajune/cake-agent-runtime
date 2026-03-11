/**
 * 共享工具函数和配置
 *
 * 包含 API 客户端和响应解包函数
 * 从 useMonitoring.ts 拆分而来（2025-12-16）
 */

import axios from 'axios';

// API 客户端实例
export const api = axios.create({
  baseURL: '',
  timeout: 10000,
});

/**
 * 解包响应数据（处理多层嵌套的 data 结构）
 * @param payload - 原始响应数据
 * @returns 解包后的数据
 */
export function unwrapResponse<T>(payload: unknown): T {
  let current = payload;
  while (current && typeof current === 'object' && 'data' in current) {
    current = (current as { data: unknown }).data;
  }
  return current as T;
}

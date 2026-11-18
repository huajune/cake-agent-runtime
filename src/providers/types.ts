/**
 * Provider 配置类型与默认值
 *
 * 每个 Provider 通过环境变量 API Key 按需注册。
 * Qwen 通过 DashScope 接入，DeepSeek 使用官方端点。
 */

import { RUNTIME_RETRY_LIMITS } from '@infra/config/constants/runtime-retry.constants';
import { ModelRole } from '@/llm/llm.types';

// ==================== 模型角色 ====================
export { ModelRole };

// ==================== Provider 配置 ====================

/** 错误分类（对标 ZeroClaw reliable.rs） */
export type ErrorCategory = 'retryable' | 'non_retryable' | 'rate_limited' | 'provider_unavailable';

/** 容错配置 */
export interface ReliableConfig {
  /** 最大尝试次数（含首次），不能超过统一上限 */
  maxRetries: number;
  /** 基础退避时间 (ms) */
  baseBackoffMs: number;
  /** 最大退避时间 (ms) */
  maxBackoffMs: number;
}

export const DEFAULT_RELIABLE_CONFIG: ReliableConfig = {
  maxRetries: RUNTIME_RETRY_LIMITS.modelAttempts,
  baseBackoffMs: 100,
  maxBackoffMs: 10_000,
};

export { supportsVision } from './models';

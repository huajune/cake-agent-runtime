/**
 * Test Suite 常量定义
 */

// 失败原因：复用全局 Agent 错误类型定义
export { AGENT_ERROR_TYPES as FAILURE_REASONS, type AgentErrorType as FailureReason } from '@/constants';

/**
 * 批次状态配置
 */
export const BATCH_STATUS_CONFIG = {
  running: { text: '执行中', className: 'running' },
  reviewing: { text: '评审中', className: 'reviewing' },
  completed: { text: '已完成', className: 'completed' },
  created: { text: '已创建', className: 'created' },
} as const;

export type BatchStatus = keyof typeof BATCH_STATUS_CONFIG;

/**
 * 执行状态配置
 */
export const EXECUTION_STATUS_CONFIG = {
  success: { text: '成功', className: 'execSuccess' },
  failure: { text: '失败', className: 'execFailure' },
  running: { text: '执行中', className: 'execRunning' },
  pending: { text: '等待', className: 'execPending' },
  timeout: { text: '超时', className: 'execFailure' },
} as const;

export type ExecutionStatus = keyof typeof EXECUTION_STATUS_CONFIG;

/**
 * 评审状态配置
 */
export const REVIEW_STATUS_CONFIG = {
  passed: { text: '通过', className: 'reviewPassed' },
  failed: { text: '不通过', className: 'reviewFailed' },
  pending: { text: '待评审', className: 'reviewPending' },
  skipped: { text: '跳过', className: 'reviewPending' },
} as const;

export type ReviewStatus = keyof typeof REVIEW_STATUS_CONFIG;

/**
 * 获取批次状态显示配置
 */
export function getBatchStatusDisplay(status: string) {
  return BATCH_STATUS_CONFIG[status as BatchStatus] || BATCH_STATUS_CONFIG.created;
}

/**
 * 获取执行状态显示配置
 */
export function getExecutionStatusDisplay(status: string) {
  return EXECUTION_STATUS_CONFIG[status as ExecutionStatus] || EXECUTION_STATUS_CONFIG.pending;
}

/**
 * 获取评审状态显示配置
 */
export function getReviewStatusDisplay(status: string) {
  return REVIEW_STATUS_CONFIG[status as ReviewStatus] || REVIEW_STATUS_CONFIG.pending;
}

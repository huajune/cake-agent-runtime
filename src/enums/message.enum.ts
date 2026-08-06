/**
 * 消息角色枚举
 * 统一定义对话消息的角色类型，用于 Agent、消息历史、监控等多个模块
 */
export enum MessageRole {
  /** 用户消息 */
  USER = 'user',
  /** AI 助手消息 */
  ASSISTANT = 'assistant',
  /** 系统消息 */
  SYSTEM = 'system',
}

/**
 * 消息处理状态。
 *
 * 用于监控、统计等模块，与 `message_processing_records.status` 列同域。
 *
 * 刻意用字符串联合而非 enum：本仓库消息侧一律以字面量联合表达状态/角色
 * （`role: 'user' | 'assistant'` 等），值来自 DB / Redis 的裸字符串，
 * 用 enum 会让每个读取点都要断言。历史上的 `ProcessingStatus` enum 因此从未被采纳，
 * 且漏了 `timeout` 一档——那正是"未进入处理"的丢消息态，不能少。
 */
export type MessageProcessingStatus = 'processing' | 'success' | 'failure' | 'timeout';

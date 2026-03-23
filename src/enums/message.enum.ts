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
 * 对话消息角色（仅用户和助手）
 * 用于聊天记录等不包含系统消息的场景
 */
export enum ChatMessageRole {
  /** 用户消息 */
  USER = 'user',
  /** AI 助手消息 */
  ASSISTANT = 'assistant',
}

/**
 * 消息处理状态枚举
 * 统一定义消息处理的状态，用于监控、统计等模块
 */
export enum ProcessingStatus {
  /** 处理中 */
  PROCESSING = 'processing',
  /** 处理成功 */
  SUCCESS = 'success',
  /** 处理失败 */
  FAILURE = 'failure',
}

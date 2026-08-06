/**
 * 会话状态枚举
 */
export enum ConversationStatus {
  /** 空闲状态：没有正在处理的消息 */
  IDLE = 'idle',
  /** 等待中：收到首条消息，正在等待聚合窗口 */
  WAITING = 'waiting',
  /** 处理中：Agent 正在处理消息 */
  PROCESSING = 'processing',
}

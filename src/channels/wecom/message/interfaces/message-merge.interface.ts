import { EnterpriseMessageCallbackDto } from '../dto/message-callback.dto';

/**
 * 待聚合的消息队列项
 */
export interface PendingMessage {
  messageData: EnterpriseMessageCallbackDto;
  receivedAt: number;
}

/**
 * 消息聚合队列（内存模式 - 旧版）
 * @deprecated 使用 ConversationState 替代
 */
export interface MessageMergeQueue {
  messages: PendingMessage[];
  timer: NodeJS.Timeout;
  firstMessageTime: number;
}

/**
 * 消息处理器函数类型
 * 接收一组消息，返回 Promise
 */
export type MessageProcessor = (messages: EnterpriseMessageCallbackDto[]) => Promise<void>;

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

/**
 * Agent 请求元数据
 */
export interface AgentRequestMetadata {
  /** 请求开始时间 */
  startTime: number;
  /** 当前重试次数（0 表示首次请求） */
  retryCount: number;
  /** 本次请求处理的消息数量 */
  messageCount: number;
}

/**
 * 会话状态（智能聚合策略）
 */
export interface ConversationState {
  /** 会话 ID (chatId) */
  chatId: string;

  /** 当前状态 */
  status: ConversationStatus;

  /** 首次消息到达时间 */
  firstMessageTime: number;

  /** 初始聚合定时器（WAITING 状态时有效） */
  initialTimer?: NodeJS.Timeout;

  /** 待处理的消息队列 */
  pendingMessages: PendingMessage[];

  /** 当前 Agent 请求元数据（PROCESSING 状态时有效） */
  currentRequest?: AgentRequestMetadata;

  /** 上次状态更新时间 */
  lastUpdateTime: number;
}

/**
 * 可持久化的会话状态（不含 timer，用于 Redis 存储）
 */
export interface PersistableConversationState {
  /** 会话 ID (chatId) */
  chatId: string;

  /** 当前状态 */
  status: ConversationStatus;

  /** 首次消息到达时间 */
  firstMessageTime: number;

  /** 待处理的消息队列 */
  pendingMessages: PendingMessage[];

  /** 当前 Agent 请求元数据（PROCESSING 状态时有效） */
  currentRequest?: AgentRequestMetadata;

  /** 上次状态更新时间 */
  lastUpdateTime: number;
}

/**
 * 溢出策略枚举
 */
export enum OverflowStrategy {
  /** 只取最新的 N 条消息 */
  TAKE_LATEST = 'take-latest',
  /** 全部聚合（不推荐） */
  TAKE_ALL = 'take-all',
}

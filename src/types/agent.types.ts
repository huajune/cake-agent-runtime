/**
 * Agent 模块类型定义
 *
 * 注意：枚举类型在 @enums/agent.enum，保持单一职责原则
 */

import { ContextStrategy } from '@enums/agent.enum';
import { MessageRole } from '@enums/message.enum';

// 重新导出 ContextStrategy 枚举，保持向后兼容
export { ContextStrategy } from '@enums/agent.enum';

// ========================================
// 消息格式
// ========================================

/**
 * AI SDK v5 兼容消息格式
 */
export interface UIMessagePart {
  type: 'text';
  text: string;
}

export interface UIMessage {
  role: MessageRole;
  parts: UIMessagePart[];
}

/**
 * 简单消息格式
 */
export interface SimpleMessage {
  role: MessageRole;
  content: string;
}

// ========================================
// Agent 配置档案
// ========================================

/**
 * 消息剪裁选项
 */
export interface PruneOptions {
  maxOutputTokens?: number;
  targetTokens?: number;
  preserveRecentMessages?: number;
}

/**
 * 上下文配置
 */
export interface ChatContext {
  preferredBrand?: string;
  dulidayToken?: string | null;
  defaultWechatId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  [key: string]: unknown;
}

/**
 * 工具特定上下文
 */
export interface ToolContext {
  [toolName: string]: {
    [key: string]: unknown;
  };
}

/**
 * Agent 配置档案
 * 定义了 Agent 的职责、使用的模型、工具和上下文
 */
export interface AgentProfile {
  /** 配置名称（唯一标识） */
  name: string;
  /** 配置描述 */
  description: string;
  /** 使用的模型，如 'anthropic/claude-sonnet-4-5-20250929' */
  model: string;
  /** 提示词类型（指定使用哪套 system prompt） */
  promptType?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 全局上下文数据 */
  context?: ChatContext;
  /** 工具级别的上下文配置 */
  toolContext?: ToolContext;
  /** 上下文缺失时的处理策略 */
  contextStrategy?: ContextStrategy;
  /** 是否启用消息剪裁 */
  prune?: boolean;
  /** 消息剪裁配置选项 */
  pruneOptions?: {
    maxOutputTokens?: number;
    targetTokens?: number;
    preserveRecentMessages?: number;
  };
}

/**
 * Agent 模块统一类型定义
 * 合并了 DTO、Model 和 Interface
 *
 * 注意：枚举类型已迁移到 ./enums.ts，保持单一职责原则
 */

// 导入枚举类型（用于类型引用）
import { AgentResultStatus, ContextStrategy } from './agent-enums';
import { MessageRole } from '@shared/enums';

// 注意：不再重新导出枚举类型，避免与 agent-enums.ts 冲突
// 使用方应该从 './agent-enums' 或 '@agent' 直接导入枚举

// ========================================
// DTO - API 请求和响应类型
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
 * 简单消息格式（会在服务端转换为 UIMessage）
 */
export interface SimpleMessage {
  role: MessageRole;
  content: string;
}

/**
 * 消息剪裁选项
 */
export interface PruneOptions {
  maxOutputTokens?: number;
  targetTokens?: number;
  preserveRecentMessages?: number;
}

/**
 * 模型配置
 */
export interface ModelConfig {
  chatModel?: string;
  classifyModel?: string;
}

/**
 * 系统提示词映射
 */
export interface SystemPrompts {
  bossZhipinSystemPrompt?: string;
  bossZhipinLocalSystemPrompt?: string;
  generalComputerSystemPrompt?: string;
  [key: string]: string | undefined;
}

/**
 * 上下文配置
 */
export interface ChatContext {
  preferredBrand?: string;
  modelConfig?: ModelConfig;
  systemPrompts?: SystemPrompts;
  dulidayToken?: string | null;
  defaultWechatId?: string | null;
  userId?: string | null; // 候选人用户 ID（即 imContactId / user_id）
  /**
   * 会话 ID（花卷 API 外部契约字段）
   * 由 AgentFacadeService.prepareRequestParams() 自动从 sessionId 参数注入，调用方无需手动设置。
   */
  sessionId?: string | null;
  [key: string]: any;
}

/**
 * 工具特定上下文
 */
export interface ToolContext {
  [toolName: string]: {
    [key: string]: any;
  };
}
// 重新导出 ContextStrategy 枚举，保持向后兼容
export { ContextStrategy } from './agent-enums';

/**
 * /api/v1/chat 请求体
 * 支持流式和非流式输出
 */
export interface ChatRequest {
  // 必填字段
  model: string;
  messages: (UIMessage | SimpleMessage)[];

  // 提示词类型（指定 Agent 使用哪套 system prompt）
  promptType?: string;

  // 流式输出配置
  stream?: boolean;

  // 消息剪裁配置
  prune?: boolean;
  pruneOptions?: PruneOptions;

  // 系统提示词
  systemPrompt?: string;

  // 工具配置
  allowedTools?: string[];

  // 上下文配置
  context?: ChatContext;
  toolContext?: ToolContext;

  // 上下文策略
  contextStrategy?: ContextStrategy;

  // 仅验证模式
  validateOnly?: boolean;

  // 扩展思考配置（AI SDK extended thinking）
  thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };

  // 渠道类型（private=私聊, group=群聊）
  channelType?: string;
}

/**
 * 非流式响应 - 使用情况统计
 */
export interface UsageStats {
  inputTokens: number; // 实际 API 返回的字段名
  outputTokens: number; // 实际 API 返回的字段名
  totalTokens: number;
  cachedInputTokens?: number; // 可选的缓存 token 统计
}

/**
 * 非流式响应 - 工具使用信息
 */
export interface ToolsInfo {
  used: string[];
  skipped: string[];
}

/**
 * 非流式响应体
 */
export interface ChatResponse {
  messages: UIMessage[];
  usage: UsageStats;
  tools: ToolsInfo;
}

/**
 * API 响应包装器（实际 API 返回格式）
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  correlationId?: string;
}

/**
 * 错误响应
 */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: any;
  statusCode: number;
  correlationId?: string;
}

// ========================================
// Model - Agent 统一响应模型
// ========================================

/**
 * Agent 错误信息
 */
export interface AgentError {
  /** 错误代码 */
  code: string;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: any;
  /** 是否可重试 */
  retryable?: boolean;
  /** 建议重试时间（秒） */
  retryAfter?: number;
}

/**
 * Agent 降级响应信息
 */
export interface AgentFallbackInfo {
  /** 降级原因 */
  reason: string;
  /** 降级消息 */
  message: string;
  /** 建议的操作 */
  suggestion?: string;
  /** 可重试时间（秒） */
  retryAfter?: number;
}

/**
 * 原始 HTTP 响应信息（用于调试和排障）
 * 直接使用 Axios 响应的核心字段，便于在监控页面查看完整的 API 响应
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawHttpResponseInfo = any;

/**
 * Agent 统一响应模型
 * 支持正常响应、降级响应和错误状态
 */
export interface AgentResult {
  /** 正常响应数据 */
  data?: ChatResponse;

  /** 降级响应（当主要服务不可用时） */
  fallback?: ChatResponse;

  /** 降级信息 */
  fallbackInfo?: AgentFallbackInfo;

  /** 错误信息 */
  error?: AgentError;

  /** 关联ID（用于追踪） */
  correlationId?: string;

  /** 是否来自缓存 */
  fromCache?: boolean;

  /** 响应状态 */
  status: AgentResultStatus;

  /** 原始 HTTP 响应信息（用于调试） */
  rawHttpResponse?: RawHttpResponseInfo;
}

// ========================================
// Interface - Agent 配置档案
// ========================================

/**
 * Agent 配置档案
 * 定义了 Agent 的职责、使用的模型、工具和上下文
 * 完全对齐 /api/v1/chat 接口契约
 */
export interface AgentProfile {
  /**
   * 配置名称（唯一标识）
   * 例如: 'wechat-group-assistant', 'boss-zhipin-recruiter'
   */
  name: string;

  /**
   * 配置描述
   */
  description: string;

  /**
   * 使用的模型（必填）
   * 例如: 'anthropic/claude-3-7-sonnet-20250219'
   */
  model: string;

  /**
   * 提示词类型（指定 Agent 使用哪套 system prompt）
   * 例如: 'weworkSystemPrompt'
   */
  promptType?: string;

  /**
   * 系统提示词
   */
  systemPrompt?: string;

  /**
   * 允许的工具列表
   * 例如: ['bash', 'zhipin_reply_generator']
   */
  allowedTools?: string[];

  /**
   * 全局上下文数据
   * 包含工具配置、系统提示词等
   */
  context?: ChatContext;

  /**
   * 工具级别的上下文配置
   * 会覆盖全局 context
   */
  toolContext?: ToolContext;

  /**
   * 上下文缺失时的处理策略
   * - error: 返回 400 错误
   * - skip: 跳过无法实例化的工具
   * - report: 仅返回验证报告
   * @default 'error'
   */
  contextStrategy?: ContextStrategy;

  /**
   * 是否启用消息剪裁
   * @default false
   */
  prune?: boolean;

  /**
   * 消息剪裁配置选项
   */
  pruneOptions?: {
    maxOutputTokens?: number;
    targetTokens?: number;
    preserveRecentMessages?: number;
  };
}

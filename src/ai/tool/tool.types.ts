import { Tool, ToolSet } from 'ai';

export type AiTool = Tool;
export type AiToolSet = ToolSet;

/**
 * 统一工具构建上下文（per-request）
 *
 * 所有工具从同一个 context 中提取所需字段。
 * 不是所有字段对所有工具都有意义 — 每个工具只取自己需要的。
 */
export interface ToolBuildContext {
  /** 用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 对话消息 */
  messages: unknown[];
  /** 渠道类型 */
  channelType: 'private' | 'public';
  /** 阶段目标配置（plan-turn 用） */
  stageGoals?: Record<string, unknown>;
  /** 岗位推荐回调（job-list 用） */
  onJobsFetched?: (jobs: unknown[]) => void;
}

/**
 * 工具工厂接口
 *
 * 所有内置工具服务必须实现此接口。
 * 对标 ZeroClaw Tool trait，但因为 context 是 per-request 的，用 factory 模式。
 */
export interface ToolFactory {
  /** 工具名称（用于 LLM function calling） */
  readonly toolName: string;
  /** 工具描述 */
  readonly toolDescription: string;
  /** 根据上下文构建 AI SDK tool 实例 */
  buildTool(context: ToolBuildContext): AiTool;
}

/**
 * 工具注册记录
 */
export interface ToolRegistration {
  name: string;
  source: 'built-in' | 'mcp';
  /** built-in 工具：工厂实例 */
  factory?: ToolFactory;
  /** MCP 工具：预构建的 tool */
  tool?: AiTool;
  /** MCP 服务器名称 */
  mcpServer?: string;
}

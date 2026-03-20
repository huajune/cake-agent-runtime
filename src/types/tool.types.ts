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
  /** 会话 ID（chatId） */
  sessionId: string;
  /** 对话消息 */
  messages: unknown[];
  /** 岗位推荐回调（job-list 用） */
  onJobsFetched?: (jobs: unknown[]) => void | Promise<void>;
}

/**
 * 工具构建函数
 *
 * 每个内置工具导出一个 ToolBuilder，接收 per-request context 返回 AI SDK tool 实例。
 */
export type ToolBuilder = (context: ToolBuildContext) => AiTool;

/**
 * 工具定义（用于 TOOL_REGISTRY）
 *
 * 通过 createToolDefinition() 创建，强制每个工具遵循同一 shape。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  create: ToolBuilder;
}

/**
 * 类型安全的工具定义构造器
 *
 * 约束所有工具必须声明 name + description + create，确保编写规范一致。
 */
export function createToolDefinition(def: ToolDefinition): ToolDefinition {
  return def;
}

/**
 * 工具注册记录（运行时，含 MCP）
 */
export interface ToolRegistration {
  name: string;
  source: 'built-in' | 'mcp';
  /** MCP 工具：预构建的 tool */
  tool?: AiTool;
  /** MCP 服务器名称 */
  mcpServer?: string;
}

import { Tool, ToolSet } from 'ai';

export type AiTool = Tool;
export type AiToolSet = ToolSet;

export interface ToolRegistration {
  name: string;
  tool: AiTool;
  /** 工具来源：built-in 内置 / mcp 来自MCP服务器 */
  source: 'built-in' | 'mcp';
  /** MCP 服务器名称（source 为 mcp 时有效） */
  mcpServer?: string;
}

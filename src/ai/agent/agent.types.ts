import { LanguageModel, ModelMessage, ToolSet } from 'ai';

export interface AgentRunParams {
  /** 模型 ID（使用 ModelService 中注册的 ID）或直接传 LanguageModel 实例 */
  model?: string | LanguageModel;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 对话消息列表 */
  messages: ModelMessage[];
  /** 工具集（不传则无工具） */
  tools?: ToolSet;
  /** 最大工具循环步数，默认 10 */
  maxSteps?: number;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

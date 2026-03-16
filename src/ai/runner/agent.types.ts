import { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { ZodType } from 'zod';

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

/** 简单文本生成参数（群任务文案等） */
export interface GenerateParams {
  model?: string | LanguageModel;
  systemPrompt?: string;
  prompt: string;
}

/** 简单文本生成结果 */
export interface GenerateResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** 结构化输出参数（评估、事实提取等） */
export interface GenerateObjectParams<T> {
  model?: string | LanguageModel;
  systemPrompt?: string;
  prompt: string;
  schema: ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
}

/** 结构化输出结果 */
export interface GenerateObjectResult<T> {
  object: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

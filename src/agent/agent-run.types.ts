import { streamText } from 'ai';

export interface AgentInputMessage {
  role: string;
  content: string;
  /** 该条 user message 关联的图片 URL 列表（test-suite/dashboard 路径） */
  imageUrls?: string[];
  /** 与 imageUrls 一一对应的图片消息 ID（wecom 路径供工具回写） */
  imageMessageIds?: string[];
}

export interface AgentInvokeParams {
  /**
   * 对话消息列表（含历史 + 当前用户消息）
   * controller / test-suite 直接调用时使用；wecom 渠道请改用 userMessage。
   */
  messages?: AgentInputMessage[];
  /**
   * 当前用户消息（wecom 渠道路径）
   * 历史消息由 ShortTermService 内部从 Supabase 读取（已含当前消息，无需重复传入）。
   */
  userMessage?: string;
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 会话 ID（chatId，用于记忆隔离） */
  sessionId: string;
  /** 场景标识，默认 candidate-consultation */
  scenario?: string;
  /** 最大工具循环步数，默认 5 */
  maxSteps?: number;
  /** 图片 URL 列表（多模态消息，传入 Agent 做 vision 识别） */
  imageUrls?: string[];
  /** 图片消息 ID 列表（供 save_image_description 工具回写 DB） */
  imageMessageIds?: string[];
  /** 策略来源：wecom 读 released，test 读 testing */
  strategySource?: 'released' | 'testing';
}

export interface AgentToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface AgentRunResult {
  text: string;
  /** 模型思考过程（需启用 AGENT_THINKING_BUDGET_TOKENS） */
  reasoning?: string;
  steps: number;
  toolCalls: AgentToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** stream() 返回结果：流 + 元数据 */
export interface AgentStreamResult {
  streamResult: ReturnType<typeof streamText>;
  entryStage: string | null;
}

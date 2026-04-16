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
  /** 当前与候选人聊天的托管账号企微 userId（拉群时作为 botUserId） */
  botUserId?: string;
  /** 候选人微信昵称（企微回调中的 contactName） */
  contactName?: string;
  /** 当前与候选人聊天的托管账号系统 wxid（拉群时作为 imBotId） */
  botImId?: string;
  /** 当前消息发送链路 token（供主动发送富消息的工具使用） */
  token?: string;
  /** 当前私聊对象系统 wxid */
  imContactId?: string;
  /** 当前群聊系统 wxid */
  imRoomId?: string;
  /** 当前发送链路 API 类型 */
  apiType?: 'enterprise' | 'group';
  /**
   * 覆盖本次调用使用的聊天模型 ID（provider/model 格式）
   * 为空时回退到 AGENT_CHAT_MODEL 角色路由。
   */
  modelId?: string;
  /**
   * 在真正调用模型前，暴露一份“实际 LLM 请求快照”给调用方做观测。
   * 仅用于埋点/调试，不参与模型请求语义。
   */
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
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
  agentRequest?: Record<string, unknown>;
}

/** stream() 返回结果：流 + 元数据 */
export interface AgentStreamResult {
  streamResult: ReturnType<typeof streamText>;
  entryStage: string | null;
  agentRequest?: Record<string, unknown>;
}

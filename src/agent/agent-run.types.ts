import { streamText } from 'ai';

export interface AgentThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens: number;
}

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
  /** 当前客户的企微 externalUserId（企业级客户详情等接口使用） */
  externalUserId?: string;
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
  /** 覆盖本次调用使用的思考模式 */
  thinking?: AgentThinkingConfig;
  /**
   * 在真正调用模型前，暴露一份“实际 LLM 请求快照”给调用方做观测。
   * 仅用于埋点/调试，不参与模型请求语义。
   */
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
}

/**
 * 工具调用状态
 * - ok: 正常返回，结果条数 >= 2
 * - empty: 返回 0 条（工具命中逻辑失败或过滤过严）
 * - narrow: 仅返回 1 条（候选人可能没的选）
 * - error: 工具抛异常 / 返回 error 字段
 */
export type AgentToolCallStatus = 'ok' | 'empty' | 'narrow' | 'error';

export interface AgentToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** 结果条数（从 result 数组 length / items / data / total / count 推断，推断不出则 undefined） */
  resultCount?: number;
  /** 调用状态分类 */
  status?: AgentToolCallStatus;
  /** 调用耗时（毫秒，best-effort；单工具/单步时较可靠） */
  durationMs?: number;
}

/** 每一步模型循环的详细快照：用于排查"模型两次调用之间想了什么"。 */
export interface AgentStepDetail {
  stepIndex: number;
  text?: string;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  durationMs?: number;
  finishReason?: string;
}

/** 本轮触发时的记忆上下文快照：用于判定"模型是否正确继承了上轮上下文"。 */
export interface AgentMemorySnapshot {
  /** 本轮入口阶段（来自 procedural.currentStage + recruitmentCase 解析） */
  currentStage: string | null;
  /** 本会话近几轮已展示给候选人的岗位 id 列表 */
  presentedJobIds: number[] | null;
  /** 上一轮 duliday_job_list 返回的候选池 jobId 列表 */
  recommendedJobIds: number[] | null;
  /** 已识别的会话事实（扁平化的 interview_info + preferences，仅留非空字段） */
  sessionFacts: Record<string, unknown> | null;
  /** 长期档案里已填充的字段名列表（不含值，避免 PII 泛滥） */
  profileKeys: string[] | null;
}

export interface AgentRunResult {
  text: string;
  /** 模型思考过程（需启用 AGENT_THINKING_BUDGET_TOKENS） */
  reasoning?: string;
  /** AI SDK generateText 返回的完整响应消息（assistant/tool） */
  responseMessages?: Array<Record<string, unknown>>;
  /** 多步循环总步数 */
  steps: number;
  /** 每一步的详细快照（AI SDK 原始 steps 的投影） */
  agentSteps: AgentStepDetail[];
  /** 扁平化的工具调用序列（含 resultCount/status/durationMs） */
  toolCalls: AgentToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  agentRequest?: Record<string, unknown>;
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
}

/** stream() 返回结果：流 + 元数据 */
export interface AgentStreamResult {
  streamResult: ReturnType<typeof streamText>;
  entryStage: string | null;
  agentRequest?: Record<string, unknown>;
}

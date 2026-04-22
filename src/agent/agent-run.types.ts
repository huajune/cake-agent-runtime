import { streamText } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import type { LlmThinkingConfig } from '@/llm/llm.types';
import type { MessageType } from '@enums/message-callback.enum';
import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';

export type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
  AgentToolCallStatus,
} from '@shared-types/agent-telemetry.types';

export type AgentThinkingConfig = LlmThinkingConfig;

export interface AgentInputMessage {
  role: string;
  content: string;
  /** 该条 user message 关联的图片 URL 列表（test-suite/dashboard 路径） */
  imageUrls?: string[];
  /** 与 imageUrls 一一对应的图片消息 ID（wecom 路径供工具回写） */
  imageMessageIds?: string[];
}

export interface AgentInvokeParams {
  /** 调用方身份；决定是否加载短期记忆、默认 strategySource 等运行时行为。 */
  callerKind: CallerKind;
  /**
   * 对话消息列表（含历史 + 当前用户消息）。
   *
   * - WECOM：只传一条当前 user 消息（`[{ role: 'user', content: ... }]`），
   *   完整历史由 memory 层从 Redis/DB 加载
   * - TEST_SUITE / DEBUG：一次性传入完整历史 + 当前消息
   */
  messages: AgentInputMessage[];
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 会话 ID（chatId，用于记忆隔离） */
  sessionId: string;
  /** 请求级 trace/message ID，用于写回 turn-end post-processing 状态。 */
  messageId?: string;
  /** 场景标识，默认 candidate-consultation */
  scenario?: string;
  /** 最大工具循环步数，默认 5 */
  maxSteps?: number;
  /** 图片/表情 URL 列表（多模态消息，传入 Agent 做 vision 识别） */
  imageUrls?: string[];
  /** 图片/表情消息 ID 列表（供 save_image_description 工具回写 DB） */
  imageMessageIds?: string[];
  /**
   * messageId → 视觉消息类型映射。
   * 仅含 IMAGE / EMOTION；供 save_image_description 工具按类型选用
   * `[图片消息]` / `[表情消息]` 前缀回写 DB。缺省条目视为 IMAGE。
   */
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
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
  /**
   * 是否在本次调用中禁用模型降级链（fallbacks）。
   * 默认 false：即便指定了 modelId，仍使用 chat 角色的 fallback 链兜底。
   * 仅在测试保真场景（test-suite）下应置为 true，确保跑的就是指定模型。
   */
  disableFallbacks?: boolean;
  /** 覆盖本次调用使用的思考模式 */
  thinking?: AgentThinkingConfig;
  /**
   * 在真正调用模型前，暴露一份“实际 LLM 请求快照”给调用方做观测。
   * 仅用于埋点/调试，不参与模型请求语义。
   */
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
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

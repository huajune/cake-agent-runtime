import { streamText } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import type { LlmThinkingConfig } from '@/llm/llm.types';
import type { MessageType } from '@enums/message-callback.enum';
import type { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';
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

export type GeneratorThinkingConfig = LlmThinkingConfig;

/**
 * Controls which tools are physically exposed to the model for this turn.
 *
 * - scenario: normal scenario toolset
 * - readonly: the physical tool constraint for proactive (reengagement) turns — the runner
 *   defaults proactive triggers to this mode so side-effect tools registered in
 *   SIDE_EFFECT_TOOLS cannot fire without the candidate driving the conversation. Not a literal
 *   read-only guarantee: some internal state projection tools are retained.
 * - none: no tools at all
 */
export const GENERATOR_TOOL_MODES = ['scenario', 'readonly', 'none'] as const;
export type GeneratorToolMode = (typeof GENERATOR_TOOL_MODES)[number];

import type { TurnLedger } from '@shared-types/turn.types';

export interface GeneratorInputMessage {
  role: string;
  content: string;
  /** WECOM 历史消息来源；用于区分真人招募经理与 Agent/自动回复。 */
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  payloadSource?: string;
  /** 该条 user message 关联的图片 URL 列表（test-suite/dashboard 路径） */
  imageUrls?: string[];
  /** 与 imageUrls 一一对应的图片消息 ID（wecom 路径供工具回写） */
  imageMessageIds?: string[];
}

export interface GeneratorInvokeParams {
  /** 调用方身份；决定是否加载短期记忆、默认 strategySource 等运行时行为。 */
  callerKind: CallerKind;
  /**
   * 对话消息列表（含历史 + 当前用户消息）。
   *
   * - WECOM：只传一条当前 user 消息（`[{ role: 'user', content: ... }]`），
   *   完整历史由 memory 层从 Redis/DB 加载
   * - TEST_SUITE / DEBUG：一次性传入完整历史 + 当前消息
   */
  messages: GeneratorInputMessage[];
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 会话 ID（chatId，用于记忆隔离） */
  sessionId: string;
  /** 请求级 trace/message ID，用于写回 turn-end post-processing 状态。 */
  messageId?: string;
  /**
   * WECOM 聚合/重跑的短期记忆截止时间。
   *
   * 入口层会在 quiet-window 结束后从 Redis pending list 取出“本批”消息，但
   * ChatSessionService.saveMessage() 会把所有入站消息即时镜像到短期记忆缓存。
   * 若 Agent 生成期间用户又发了新消息，那条消息可能已经进了 short-term cache，
   * 但还没有被当前批次消费。这里传入本批最大消息时间戳，让 memory 层只读取
   * `timestamp <= cutoff` 的历史，避免上一批提前吃到下一批 pending 消息。
   */
  shortTermEndTimeInclusive?: number;
  /** 不可逆工具提交前检查当前回合启动后是否又收到候选人消息。 */
  hasNewerUserInput?: () => Promise<boolean>;
  /** 场景标识，默认 candidate-consultation */
  scenario?: string;
  /** 最大工具循环步数，默认 5 */
  maxSteps?: number;
  /** 本轮物理工具集模式；默认 scenario，见 GeneratorToolMode。 */
  toolMode?: GeneratorToolMode;
  /**
   * 精确工具授权。提供时在 toolMode 的基础工具集上再取白名单交集。
   * 当前生产消费方是 test-suite 保真链路（replan 退役后守卫不再传工具白名单）。
   */
  allowedToolNames?: string[];
  /**
   * reengagement 主动回合的跟进目标（喂给生成方的 directive）。
   * 注入 system prompt 末尾，告诉模型"本回合是系统发起的主动跟进，目标是 X"，
   * 由模型按记忆/上下文实时生成话术（不固化模板）。被动回合不传。
   */
  proactiveDirective?: string;
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
  /** 当前消息所属小组 ID（企业级回调有值时用于配置兜底） */
  groupId?: string;
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
  thinking?: GeneratorThinkingConfig;
  /**
   * 在真正调用模型前，暴露一份“实际 LLM 请求快照”给调用方做观测。
   * 仅用于埋点/调试，不参与模型请求语义。
   */
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
}

export interface GeneratorRunResult {
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
    /** 前缀缓存命中的输入 token（回合内各 step 求和）；undefined = provider 未上报。 */
    cachedInputTokens?: number;
  };
  agentRequest?: Record<string, unknown>;
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
  /** agent 运行时拥有的本轮账本；runner/guardrail 仅借阅只读证据。 */
  turnLedger?: TurnLedger;
  /**
   * turn-end 生命周期触发器。`invoke()` / `stream()` 返回的结果上**必然存在**
   * （attachTurnEnd 无条件挂载；fire-and-forget 默认分支已随 deferTurnEnd 开关删除）。
   *
   * ⚠️ **硬契约**：调用 invoke 后必须在本轮结局定局时触发一次 runTurnEnd，
   * 否则本轮记忆投影/事实提取静默丢失——删掉 fire-and-forget 兜底后这是唯一防线。
   * 生产链路由 TurnFinalizer 统一承担该职责；`stream()` 在 onFinish 内自触发。
   *
   * 类型仍为 optional：runner/turn-outcome 在把闭包交给 TurnFinalizer 后会显式置
   * `runTurnEnd: undefined`，用"字段为空"表示"已被接管，渠道层不要再碰"。
   *
   * 调用方对本次生成结果「最终采纳」后调用一次即可（内部幂等，重复调用是空操作）。
   * 若本次结果被丢弃（如 replay 首次调用），直接忽略。
   *
   * `includeAssistantText`（默认 true）：本轮回复是否真实投递给了用户。被出站守卫拦截、
   * 主动沉默、或投递阶段因托管暂停/失败而未送达时，调用方应传 `false`——此时仍记录
   * 用户侧记忆（事实提取/活跃刷新），但不把「用户没看到的回复」投影成助手轮次，避免
   * 污染下一轮 recall 与复聊判定。
   */
  runTurnEnd?: (opts?: {
    includeAssistantText?: boolean;
    /** 投递前确定性改写后的真实可见文本；省略时沿用生成原文。 */
    assistantTextOverride?: string;
  }) => Promise<void>;
}

/** stream() 返回结果：流 + 元数据 */
export interface GeneratorStreamResult {
  streamResult: ReturnType<typeof streamText>;
  entryStage: string | null;
  agentRequest?: Record<string, unknown>;
}

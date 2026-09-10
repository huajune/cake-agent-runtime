import type { CallerKind } from '@/enums/agent.enum';
import type {
  AgentToolCall,
  GeneratorInvokeParams,
  GeneratorRunResult,
  GeneratorToolMode,
} from '../generator/generator.types';
import type {
  GuardrailRiskLevel,
  GuardrailTurnTrace,
  InputRiskType,
  OutputDecision,
  OutputResolution,
} from '@shared-types/guardrail.contract';
import type { TurnSideEffectIntent } from './turn-side-effect.types';

/** 会话三元组（记忆隔离键）。 */
export interface SessionRef {
  corpId: string;
  userId: string;
  sessionId: string;
}

/** 回合运行所需的渠道/身份上下文（透传给 generator）。 */
export interface TurnContext
  extends Pick<
    GeneratorInvokeParams,
    | 'scenario'
    | 'imageMessageIds'
    | 'visualMessageTypes'
    | 'externalUserId'
    | 'groupId'
    | 'thinking'
    | 'shortTermEndTimeInclusive'
    | 'hasNewerUserInput'
    | 'onPreparedRequest'
  > {
  callerKind?: CallerKind;
  contactName?: string;
  botImId?: string;
  botUserId?: string;
  token?: string;
  imContactId?: string;
  imRoomId?: string;
  apiType?: 'enterprise' | 'group';
  /** 请求级 trace/message ID，用于 turn-end 回写与 handoff 幂等键。 */
  messageId?: string;
}

/**
 * 被动入站回合。
 *
 * 主动复聊由 reengagement 域的 ReengagementAgent 独立承载，不能伪装成 user message
 * 进入本协议。这里直接表达真实输入，避免触发类型分支扩散到 runner/generator。
 */
export interface InboundTurnRequest {
  sessionRef: SessionRef;
  input: {
    text: string;
    images?: string[];
  };
  context?: TurnContext;
  /** 物理工具集模式；生产入站默认使用场景工具集。 */
  toolMode?: GeneratorToolMode;
  modelId?: string;
}

/**
 * 一个**已审回合**的产出（runner 渠道无关，不负责投递）。
 *
 * - reply       ：可对外投递的回复
 * - skipped     ：本轮沉默（空文本/短路/skip_reply）——不投递、不告警
 * - handoff     ：入站分流、业务/工具或出站审查后转人工——不投递，由 sideEffects 提交暂停与通知
 */
export interface TurnOutcome {
  kind: 'reply' | 'handoff' | 'skipped';
  reply?: { text: string };
  toolCalls: AgentToolCall[];
  /** 审查后的生成文本；reply 时等于 reply.text，非投递终态时供观测留痕。 */
  generatedText?: string;
  reasoning?: GeneratorRunResult['reasoning'];
  usage?: GeneratorRunResult['usage'];
  agentSteps?: GeneratorRunResult['agentSteps'];
  memorySnapshot?: GeneratorRunResult['memorySnapshot'];
  responseMessages?: GeneratorRunResult['responseMessages'];
  /**
   * 入站守卫分流到 handoff 后的处置意图。出站无法安全放行也使用 handoff；
   * 元叙述有意静默使用 skipped，保留既有工具意图但不新增介入。
   */
  disposition?: 'side_effects' | 'silent';
  /** reengagement 独立链路的观测字段；主 Runner 不写入。 */
  scenarioCode?: string;
  /** 守卫归因独立于业务终态，入站拦截、出站转人工或有意静默均可携带。 */
  guardrail?: {
    phase: 'inbound' | 'outbound';
    source: 'input_guardrail' | 'output_guardrail';
    ruleIds?: string[];
    reasonCode?: string;
    reason?: string;
    riskType?: InputRiskType;
    riskLabel?: string;
    inspectedText?: string;
    /** 是否有确定性规则的不可发送命中。 */
    ruleBlocked?: boolean;
  };
  /**
   * 出站审查意见与最终处置摘要；降级放行也保留真实审查意见。
   * 入站直接转人工（handoff/inbound）时不会产生出站决策，此字段为空。
   */
  outputGuardrail?: {
    decision: OutputDecision;
    finalOutcome: OutputResolution['outcome'];
    riskLevel: GuardrailRiskLevel;
    ruleIds: string[];
    blockedRuleIds: string[];
    reasonCode?: string;
    /** 是否采用修复后的生成结果。 */
    revised: boolean;
  };
  /** 出站守卫全程 trace（首审→repair→二审），供流水落库与调试页展示；守卫未运行时为空。 */
  guardrailTrace?: GuardrailTurnTrace;
  /**
   * 守卫声明的副作用意图（人工介入暂停/告警等）。守卫只判定不执行；
   * 渠道在 replay 定局后经 TurnOutcomeInterventionService.commit 统一出口执行，
   * 避免被 replay 丢弃的首版误触发暂停托管/告警。
   */
  sideEffects?: TurnSideEffectIntent[];
  /**
   * 暴露给调用方，投递结局已知后显式触发一次记忆收尾（被 TurnFinalizer 接管后置空）。
   * `includeAssistantText=false`（默认 true）：回复未真实送达（守卫拦截/沉默/投递失败）时，
   * 只记用户侧记忆，不投影助手轮次。
   */
  runTurnEnd?: (opts?: { includeAssistantText?: boolean }) => Promise<void>;
  /** 普通介入的提交元数据；入站风险由 guardrail 归因及 conversation_risk 意图完整表达。 */
  handoff?: {
    source: 'agent_tool' | 'output_guardrail';
    reasonCode: string;
    reason?: string;
    /** 仅工具触发的介入携带，Runner 审查失败不伪造工具调用。 */
    sourceToolCall?: string;
    /** `${chatId}:handoff:${turnId}` —— 与现有 request_handoff 一致。 */
    idempotencyKey: string;
    /** 兼容旧工具结果：若副作用已在工具内执行，outcome 出口不再重复执行。 */
    alreadyDispatched?: boolean;
  };
}

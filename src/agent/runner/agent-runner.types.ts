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
 * 进入本协议。这里直接表达真实输入，避免 trigger.kind 分支扩散到 runner/generator。
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
 * - guardrail_blocked：入站/出站守卫拦截——不投递，处置策略由 sideEffects/disposition 显式表达
 * - handoff     ：非 guardrail 的业务/工具转人工——不投递 + 转人工（pause+告警，由 outcome sideEffects 统一出口执行）
 */
export interface TurnOutcome {
  kind: 'reply' | 'skipped' | 'guardrail_blocked' | 'handoff';
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
   * guardrail_blocked 的处置意图。默认不允许裸静默；如未来确需静默，必须显式置 silent。
   * 当前线上策略：守卫拦截默认通过 sideEffects 触发人工兜底；例外是出站
   * meta_narration 静默（真人插话场景不自动派人工，仅落审查档案）。
   */
  disposition?: 'side_effects' | 'silent';
  /** reengagement 独立链路的观测字段；主 Runner 不写入。 */
  scenarioCode?: string;
  /** kind==='guardrail_blocked' 时携带守卫归因，phase 区分入站/出站。 */
  guardrail?: {
    phase: 'inbound' | 'outbound';
    source: 'input_guardrail' | 'output_guardrail';
    ruleIds?: string[];
    reasonCode?: string;
    reason?: string;
    riskType?: InputRiskType;
    riskLabel?: string;
    inspectedText?: string;
    /** 是否由确定性 rule 档拦截；guardrail_blocked 总是显式携带处置策略。 */
    ruleBlocked?: boolean;
  };
  /**
   * 出站守卫裁决摘要（所有 outcome 均携带，pass/revise/block 都记录，供观测层全量感知）。
   * 入站被拦截（guardrail_blocked/inbound）时不会产生出站决策，此字段为空。
   */
  outputGuardrail?: {
    decision: OutputDecision;
    riskLevel: GuardrailRiskLevel;
    ruleIds: string[];
    blockedRuleIds: string[];
    reasonCode?: string;
    /** 本回合是否触发了 revise 重写（最终 pass 也记录）。 */
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
  handoff?: {
    reasonCode: string;
    reason?: string;
    sourceToolCall: string;
    /** `${chatId}:handoff:${turnId}` —— 与现有 request_handoff 一致。 */
    idempotencyKey: string;
    /** 兼容旧工具结果：若副作用已在工具内执行，outcome 出口不再重复执行。 */
    alreadyDispatched?: boolean;
  };
}

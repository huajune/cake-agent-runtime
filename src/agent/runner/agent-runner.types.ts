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
 * 触发源：被动（候选人消息）/ 主动（reengagement 复聊）。
 * 两者汇入同一个 runTurn（渠道无关）。
 */
export type TurnTrigger =
  | { kind: 'inbound'; userMessage: string; images?: string[] }
  | { kind: 'proactive'; directive: string; scenarioCode: string };

export interface TurnRequest {
  sessionRef: SessionRef;
  trigger: TurnTrigger;
  context?: TurnContext;
  /** 物理工具集模式；主动回合默认 readonly（禁副作用工具）。 */
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
   * 当前线上策略：入站/出站守卫拦截均通过 sideEffects 触发人工兜底。
   */
  disposition?: 'side_effects' | 'silent';
  /** reengagement/观测用：本回合命中的主动场景码。 */
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
   * deferTurnEnd 时暴露给调用方，投递成功后显式触发记忆收尾。
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

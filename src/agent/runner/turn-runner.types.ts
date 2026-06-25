import type { CallerKind } from '@/enums/agent.enum';
import type { AgentToolCall, ToolMode } from '../agent-run.types';

/** 会话三元组（记忆隔离键）。 */
export interface SessionRef {
  corpId: string;
  userId: string;
  sessionId: string;
}

/** 回合运行所需的渠道/身份上下文（透传给 generator）。 */
export interface TurnContext {
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
  toolMode?: ToolMode;
  modelId?: string;
}

/**
 * 一个**已审回合**的产出（runner 渠道无关，不负责投递）。
 *
 * - reply   ：可对外投递的回复
 * - skipped ：本轮沉默（空文本/短路/skip_reply）——不投递、不告警
 * - blocked ：出站守卫拦下普通话术问题——不投递、记观测，不暂停托管
 * - handoff ：高危/结构性——不投递 + 转人工（pause+告警，由 outcome 层 dispatch）
 */
export interface TurnOutcome {
  kind: 'reply' | 'skipped' | 'blocked' | 'handoff';
  reply?: { text: string };
  toolCalls: AgentToolCall[];
  /** reengagement/观测用：本回合命中的主动场景码。 */
  scenarioCode?: string;
  /** deferTurnEnd 时暴露给调用方，投递成功后显式触发记忆收尾。 */
  runTurnEnd?: () => Promise<void>;
  handoff?: {
    reasonCode: string;
    reason?: string;
    sourceToolCall: string;
    /** `${chatId}:handoff:${turnId}` —— 与现有 request_handoff 一致。 */
    idempotencyKey: string;
    /** 迁移期：request_handoff 在工具内已 dispatch → true，outcome 层不再 dispatch。 */
    alreadyDispatched?: boolean;
  };
}

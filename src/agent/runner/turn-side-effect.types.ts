import type {
  InterventionMessageSnapshot,
  GeneralHandoffInterventionPayload,
  RiskInterventionPayload,
} from '@biz/intervention/intervention.service';
import type { WeworkSessionState } from '@memory/types/session-facts.types';

type ConversationRiskSource = RiskInterventionPayload['source'];
type GeneralHandoffSource = GeneralHandoffInterventionPayload['source'];

interface TurnSideEffectBase {
  /**
   * 迁移兼容：副作用已经在工具/旧守卫内触发过时，统一出口只记录/跳过，不重复执行。
   */
  alreadyDispatched?: boolean;
  currentMessageContent?: string;
  recentMessages?: InterventionMessageSnapshot[];
  sessionState?: WeworkSessionState | null;
}

export interface ConversationRiskSideEffectIntent extends TurnSideEffectBase {
  kind: 'conversation_risk';
  source: ConversationRiskSource;
  riskType: RiskInterventionPayload['riskType'];
  riskLabel: string;
  summary: string;
  reason: string;
}

export interface GeneralHandoffSideEffectIntent extends TurnSideEffectBase {
  kind: 'general_handoff';
  source: GeneralHandoffSource;
  alertLabel: string;
  reasonCode: string;
  reason: string;
  actionAdvice?: string;
  stage?: string | null;
  workOrderId?: number | null;
  botImId?: string;
  idempotencyKey?: string;
  /** 是否写 handoff_events / ops_events 底账。兼容旧已写入场景时可置 false。 */
  recordHandoff?: boolean;
}

export type TurnSideEffectIntent =
  | ConversationRiskSideEffectIntent
  | GeneralHandoffSideEffectIntent;

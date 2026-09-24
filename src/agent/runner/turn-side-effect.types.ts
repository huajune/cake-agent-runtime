import type {
  InterventionMessageSnapshot,
  GeneralHandoffInterventionPayload,
  RiskInterventionPayload,
} from '@biz/intervention/intervention.service';
import type { WeworkSessionState } from '@memory/short-term/short-term.types';
import type { HandoffEventOrigin } from '@biz/handoff-events/handoff-events.types';

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
  /** 岗位数据缺口：候选人问到而岗位字段没有答案的信息点（salary_admin_inquiry 场景）。 */
  missingJobInfo?: string[];
  stage?: string | null;
  workOrderId?: number | null;
  /**
   * 转人工当轮的焦点岗位 jobId，落 handoff_events.job_id + ops_events payload。
   * 供运营按岗位定位「该改哪个岗位数据 / 该给哪个岗位加名额」。
   */
  jobId?: number | null;
  botImId?: string;
  idempotencyKey?: string;
  /** 是否写 handoff_events / ops_events 底账。兼容旧已写入场景时可置 false。 */
  recordHandoff?: boolean;
  /**
   * 只记底账、不再暂停/告警：工具内已自行暂停托管并发过卡片（booking 失败）时用，
   * 让这类介入进 handoff_events 而不重复打扰运营。
   */
  recordOnly?: boolean;
  /** 介入来源标记（落 ops_events payload.origin）。 */
  origin?: HandoffEventOrigin;
}

export type TurnSideEffectIntent =
  | ConversationRiskSideEffectIntent
  | GeneralHandoffSideEffectIntent;

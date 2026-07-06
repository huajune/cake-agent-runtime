import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { SessionRef } from '../runner/agent-runner.types';

export const REENGAGEMENT_QUEUE = 'reengagement';
export const REENGAGEMENT_JOB_NAME = 'follow-up';

export type FollowUpScenarioCode =
  | 'opening_no_reply'
  | 'address_missing'
  | 'store_presented_no_reply'
  | 'booking_incomplete'
  | 'interview_reminder'
  | 'post_interview_followup'
  | 'new_job_for_waiting';

export interface FollowUpScenarioContext {
  anchorAt: number;
  state: AuthoritativeSessionState;
}

/** 场景所属大阶段：报名前 / 报名后（报名后流程复杂，支持独立大开关）。 */
export type FollowUpScenarioPhase = 'pre_booking' | 'post_booking';

/** 场景级灰度的运行时配置切片（来自 Dashboard 托管配置，即时生效）。字段缺失按不收紧处理。 */
export interface ScenarioRolloutConfig {
  /** 报名后大场景独立开关：显式 false 时报名后场景全部只 shadow；缺失视为开。 */
  reengagementPostBookingEnabled?: boolean;
  /** 场景级开关 map（key=场景 code）；未配置的场景回退代码默认值。 */
  reengagementScenarioRollout?: Record<string, boolean>;
}

/** 结构化场景配置（非 prompt 常量）。 */
export interface FollowUpScenario {
  code: FollowUpScenarioCode;
  /** 所属大阶段：报名后场景受 reengagementPostBookingEnabled 大开关额外约束。 */
  phase: FollowUpScenarioPhase;
  /** 场景中文名（Dashboard 配置页只读展示）。 */
  displayName: string;
  /** 锚点事件名（ops_events / turn-end hook）。 */
  anchorEvent: string;
  /** 锚点事件中文说明（Dashboard 配置页只读展示）。 */
  anchorLabel: string;
  /** 相对锚点延迟；面试提醒等依赖 interviewTime 的传函数。 */
  triggerDelayMs: number | ((ctx: FollowUpScenarioContext) => number);
  /** 触发延迟人话描述（triggerDelayMs 为函数时无法直接序列化，展示走这里）。 */
  delayLabel: string;
  /** 跟进目标（喂 runner 的 proactive directive）。 */
  objective: string;
  /** 排程前/触发时必须具备的权威状态字段（审计用）。 */
  requiredEvidence: string[];
  /** 场景是否仍成立；返回 false → 丢弃，不触发。 */
  stopUnless: (state: AuthoritativeSessionState) => boolean;
  /** 语气与禁止项（不夸大/不承诺/不骚扰/拒绝即止）。 */
  generationPolicy: string;
  /** 场景级灰度默认值：运行时以托管配置 reengagementScenarioRollout 为准，未配置时回退此值。 */
  defaultRolloutEnabled: boolean;
}

/** Bull job payload。 */
export interface FollowUpJob {
  sessionRef: SessionRef;
  scenarioCode: FollowUpScenarioCode;
  anchorEventId: string;
  anchorAt: number;
  /**
   * 报名后场景（booking.succeeded 锚点）携带的工单 ID：processor 到点凭它向海绵核验
   * 工单现状（外部取消/已面试）。缺失（存量任务/提取失败）时跳过核验，回退旧停止规则。
   */
  workOrderId?: number;
  /**
   * 排程时冻结的期望面试时间（毫秒）。到点与 active_booking.interview_time 比对，
   * 不一致说明发生过改约（改约锚点已按新时间排了替代任务），旧任务应停。
   */
  expectedInterviewAt?: number;
}

export interface ShouldStopResult {
  stop: boolean;
  reason?: string;
}

/** 触达底账 outbox 状态机。 */
export type TouchSlotState = 'reserved' | 'delivery_attempted' | 'sent' | 'failed' | 'unknown';

export type ReserveResult = 'reserved' | 'duplicate_sent' | 'duplicate_inflight';

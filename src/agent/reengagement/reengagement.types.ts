import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { SessionRef } from '../runner/turn-runner.types';

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

/** 结构化场景配置（非 prompt 常量）。 */
export interface FollowUpScenario {
  code: FollowUpScenarioCode;
  /** 锚点事件名（ops_events / turn-end hook）。 */
  anchorEvent: string;
  /** 相对锚点延迟；面试提醒等依赖 interviewTime 的传函数。 */
  triggerDelayMs: number | ((ctx: FollowUpScenarioContext) => number);
  /** 跟进目标（喂 runner 的 proactive directive）。 */
  objective: string;
  /** 排程前/触发时必须具备的权威状态字段（审计用）。 */
  requiredEvidence: string[];
  /** 场景是否仍成立；返回 false → 丢弃，不触发。 */
  stopUnless: (state: AuthoritativeSessionState) => boolean;
  /** 语气与禁止项（不夸大/不承诺/不骚扰/拒绝即止）。 */
  generationPolicy: string;
  /** 灰度开关：true=允许真发（关 shadow 后），false=永远只 shadow。 */
  rolloutEnabled: boolean;
}

/** Bull job payload。 */
export interface FollowUpJob {
  sessionRef: SessionRef;
  scenarioCode: FollowUpScenarioCode;
  anchorEventId: string;
  anchorAt: number;
}

export interface ShouldStopResult {
  stop: boolean;
  reason?: string;
}

/** 触达底账 outbox 状态机。 */
export type TouchSlotState = 'reserved' | 'delivery_attempted' | 'sent' | 'failed' | 'unknown';

export type ReserveResult = 'reserved' | 'duplicate_sent' | 'duplicate_inflight';

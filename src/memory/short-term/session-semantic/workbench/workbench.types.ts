import { z } from 'zod';
import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';

/**
 * 阶段状态 — 招聘流程阶段状态。
 *
 * 只有 `currentStage` 一个字段（2026-08-19 记忆审计 S10）：原先还落
 * `fromStage` / `advancedAt` / `reason` 三个"审计"字段，但它们只写不读。
 * 阶段变迁的真实审计链在 advance_stage 日志、agent_execution_events 与
 * message_processing_records；这里仅保存下一轮要读取的流程指针。
 */
export interface StageState {
  /** 当前这段会话停留在哪个业务阶段。 */
  currentStage: string | null;
}

/** 最近一次 duliday_job_list 的查询签名记录。 */
export interface JobListQueryRecord {
  /** 归一化过滤条件的稳定序列化（见 tools/shared/job-list-query-signature.ts）。 */
  signature: string;
  /** 执行该查询的 turnId（= 触发消息 messageId）；用于排除同轮 Bull 重试误判。 */
  turnId: string | null;
  updatedAtMs?: number | null;
}

/** session-semantic 工作台舱字段；由 facts.types 的 hash 总契约组合引用。 */
export interface SessionWorkbenchState {
  /** 每轮覆盖：最后一次 duliday_job_list 调用返回的候选岗位池。 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位。 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 本次求职会话累计发生过的推店轮次。 */
  storePresentationRounds?: number;
  /** 候选人当前明确在聊或准备报名的岗位。 */
  currentFocusJob: RecommendedJobSummary | null;
  /** 最近一次 duliday_job_list 查询签名（跨轮重复查询检测）。 */
  lastJobListQuery?: JobListQueryRecord | null;
}

export const JobListQueryRecordSchema = z.object({
  signature: z.string(),
  turnId: z.string().nullable(),
  updatedAtMs: z.number().nullable().optional(),
});

export const SessionWorkbenchStateSchema = z.object({
  lastCandidatePool: z.array(RecommendedJobSummarySchema).nullable(),
  presentedJobs: z.array(RecommendedJobSummarySchema).nullable(),
  storePresentationRounds: z.number().int().nonnegative().optional(),
  currentFocusJob: RecommendedJobSummarySchema.nullable(),
  lastJobListQuery: JobListQueryRecordSchema.nullable().optional(),
});

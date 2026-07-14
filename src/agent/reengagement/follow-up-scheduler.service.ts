import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue, type JobStatus } from 'bull';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { SessionRef } from '../runner/agent-runner.types';
import {
  computeFireAt,
  getScenario,
  hasInterviewAt,
  shouldStop,
  type FollowUpScenario,
  type FollowUpScenarioCode,
} from './scenario-registry';

// 场景注册表 + 时窗/停止工具已拆到 ./scenario-registry；re-export 保持既有 import 路径可用。
export * from './scenario-registry';

export const REENGAGEMENT_QUEUE = 'reengagement';
export const REENGAGEMENT_JOB_NAME = 'follow-up';

/**
 * 渠道身份快照（排程时冻结）：候选人微信昵称 + 接管 bot + 稳定收件人标识。
 * 随任务落到 reengagement_touch_records，追溯页直读列，不做查询期关联。
 * 复聊只面向候选人私聊；投递凭证统一在到点发送时读取 STRIDE_ENTERPRISE_TOKEN。
 */
export interface ReengagementChannelIdentity {
  candidateName?: string;
  managerName?: string;
  botImId?: string;
  imContactId?: string;
  externalUserId?: string;
}

/** Bull job payload。 */
export interface FollowUpJob {
  sessionRef: SessionRef;
  scenarioCode: FollowUpScenarioCode;
  anchorEventId: string;
  anchorAt: number;
  /** 渠道身份快照（排程时冻结，观测用；存量任务可能缺失） */
  channelIdentity?: ReengagementChannelIdentity;
  /**
   * 报名后场景（booking.succeeded 锚点）携带的工单 ID：processor 到点凭它向海绵查询
   * 最新工单。缺失（存量任务/提取失败）时 fail closed，不生成、不发送。
   */
  workOrderId?: number;
  /**
   * @deprecated 仅兼容存量任务；不得再作为生成或发送依据。
   */
  expectedInterviewAt?: number;
  /** @deprecated 仅兼容存量任务；不得再作为生成或发送依据。 */
  interviewType?: string;
  /** 仅携带稳定工单引用、等待海绵同步后解析正式触达时间的重试任务。 */
  resolveBookingAtFire?: boolean;
}

/** 触达底账 outbox 状态机。 */
export type TouchSlotState = 'reserved' | 'delivery_attempted' | 'sent' | 'failed' | 'unknown';

export type ReserveResult = 'reserved' | 'duplicate_sent' | 'duplicate_inflight';

export interface ScheduleFollowUpInput {
  sessionRef: SessionRef;
  scenarioCode: FollowUpScenarioCode;
  /** 锚点事件唯一 id（幂等键的一部分）。 */
  anchorEventId: string;
  anchorAt: number;
  /**
   * 权威状态（可选）。提供时做排程前停止条件预检 + 动态延迟（如 interview_reminder
   * 依赖 interviewTime）；缺省时跳过预检、用常量延迟（processor 到点会再读权威态做
   * 完整 shouldStop，不漏判）。
   */
  state?: AuthoritativeSessionState;
  /** 报名后场景的工单 ID（processor 到点向海绵核验工单现状用）。 */
  workOrderId?: number;
  /** 只用于本次计算延迟，不写入新任务 payload。 */
  expectedInterviewAt?: number;
  /** 只用于本次计算 AI 面试回访延迟，不写入新任务 payload。 */
  interviewType?: string;
  /** 渠道身份快照（候选人昵称/接管 bot），随触达记录落库供追溯页直读。 */
  channelIdentity?: ReengagementChannelIdentity;
}

function createEmptyState(): AuthoritativeSessionState {
  return {
    collectedFields: {},
    recalledJobIds: new Set<number>(),
    hardConstraints: [],
    presentedStores: [],
    stage: null,
  };
}

const PENDING_JOB_STATUSES: JobStatus[] = ['delayed', 'waiting', 'paused'];

export interface ScheduleFollowUpResult {
  scheduled: boolean;
  reason?: string;
  fireAt?: number;
  jobId?: string;
}

export interface ScheduleBookingResolutionInput {
  sessionRef: SessionRef;
  scenarioCode: Extract<FollowUpScenarioCode, 'interview_reminder' | 'post_interview_followup'>;
  workOrderId: number;
  anchorEventId: string;
  anchorAt: number;
  channelIdentity?: ReengagementChannelIdentity;
}

/**
 * 复聊排程：锚点事件发生时排一个 Bull delayed job（不轮询全量会话）。
 *
 * 幂等：jobId = `${sessionId}:${scenarioCode}:${anchorEventId}`（Bull 同 jobId 去重）。
 * ⚠️ Bull `delay` 是相对 ms，不是绝对 fireAt：computeFireAt 返回绝对时间戳，
 * 这里转成 `max(0, fireAt - now)`。
 */
@Injectable()
export class FollowUpSchedulerService {
  private readonly logger = new Logger(FollowUpSchedulerService.name);

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    private readonly systemConfig: SystemConfigService,
    private readonly tracking: ReengagementTrackingService,
  ) {}

  /**
   * 总开关：Dashboard 运行时配置 `reengagementEnabled`（DB 动态读，1s 热缓存，即时生效；
   * DB 未持久化过时回退环境变量 REENGAGEMENT_ENABLED）。投递与否由 shadow 控制，见 processor。
   */
  private async isEnabled(): Promise<boolean> {
    const config = await this.systemConfig.getAgentReplyConfig();
    return config.reengagementEnabled;
  }

  async scheduleFollowUp(input: ScheduleFollowUpInput): Promise<ScheduleFollowUpResult> {
    if (!(await this.isEnabled())) return { scheduled: false, reason: 'disabled' };

    const scenario = getScenario(input.scenarioCode);
    if (!scenario) return { scheduled: false, reason: 'unknown_scenario' };

    const state = input.state ?? createEmptyState();

    const identity: ReengagementTouchIdentity = {
      sessionId: input.sessionRef.sessionId,
      userId: input.sessionRef.userId,
      corpId: input.sessionRef.corpId,
      scenarioCode: input.scenarioCode,
      anchorEventId: input.anchorEventId,
      anchorAt: input.anchorAt,
      ...input.channelIdentity,
    };

    // 报名后触达必须绑定明确面试时间。等通知/无面试时间岗位没有可提醒或回访的时间点，
    // 不生成主动触达任务，避免按报名成功锚点兜底骚扰候选人。
    if (scenario.phase === 'post_booking' && !hasInterviewAt(state)) {
      this.tracking.trackScheduleSkipped(identity, 'missing_interview_time');
      return { scheduled: false, reason: 'missing_interview_time' };
    }

    // 排程前停止条件预检（仅当提供了 state）——能省一个无效 delayed job；
    // 缺 state 时跳过预检，processor 到点会读权威态再做完整 shouldStop。
    if (input.state) {
      const stop = shouldStop(scenario, input.state, input.anchorAt, {
        externallyVerifiable: input.workOrderId != null,
      });
      if (stop.stop) {
        this.tracking.trackScheduleSkipped(identity, stop.reason ?? 'precheck_stop');
        return { scheduled: false, reason: stop.reason };
      }
    }

    const fireAt = computeFireAt(scenario, {
      anchorAt: input.anchorAt,
      state,
      interviewType: input.interviewType,
    });
    const delay = Math.max(0, fireAt - Date.now());
    const jobId = this.buildJobId(
      input.sessionRef.sessionId,
      input.scenarioCode,
      input.anchorEventId,
    );

    // Bull 同 jobId 的重复 add 是静默 no-op（幂等锚点刻意依赖这点），但 trackScheduled
    // 会无条件把底账 fire_at/scheduled_at 覆写成一个不会触发的新时间（已完成的任务上
    // 表现为 status=sent 却挂着未来的幽灵 fire_at）。存量任务已在（在途/保留期内已完成）
    // → 排程与落库一并跳过；存量查询失败按不存在放行，去重仍由 Bull 兜底。
    let existingJob: Job<FollowUpJob> | null = null;
    try {
      existingJob = await this.queue.getJob(jobId);
    } catch {
      existingJob = null;
    }
    if (existingJob) {
      this.logger.debug(`[reengagement] jobId=${jobId} 已存在，跳过重复排程与底账写入`);
      return { scheduled: false, reason: 'duplicate_job', jobId };
    }

    const pendingCleanup = await this.removeSupersededPendingJobsBeforeEnqueue(
      input,
      scenario,
      jobId,
    );
    if (pendingCleanup.blockedByBookingIncomplete) {
      this.tracking.trackScheduleSkipped(identity, 'dominated_by_booking_incomplete');
      return {
        scheduled: false,
        reason: 'dominated_by_booking_incomplete',
        jobId,
      };
    }

    try {
      await this.queue.add(
        REENGAGEMENT_JOB_NAME,
        {
          sessionRef: input.sessionRef,
          scenarioCode: input.scenarioCode,
          anchorEventId: input.anchorEventId,
          anchorAt: input.anchorAt,
          ...(input.workOrderId != null ? { workOrderId: input.workOrderId } : {}),
          ...(input.channelIdentity ? { channelIdentity: input.channelIdentity } : {}),
        },
        {
          jobId,
          delay,
          attempts: 2,
          backoff: { type: 'fixed', delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
        },
      );
      this.logger.log(
        `[reengagement] 已排程 jobId=${jobId} fireAt=${new Date(fireAt).toISOString()} delay=${delay}ms`,
      );
      this.tracking.trackScheduled(identity, jobId, fireAt);
      return { scheduled: true, fireAt, jobId };
    } catch (error) {
      this.logger.error(
        `[reengagement] 排程失败 jobId=${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.tracking.trackScheduleError(
        identity,
        error instanceof Error ? error.message : String(error),
      );
      return { scheduled: false, reason: 'enqueue_error' };
    }
  }

  /**
   * 预约刚成功时只持久化工单定位信息。worker 以 Bull 重试查询海绵，拿到实时工单后
   * 再创建正式 delayed job，避免把预约工具入参或尚未同步的本地快照冻结成业务事实。
   */
  async scheduleBookingResolution(
    input: ScheduleBookingResolutionInput,
  ): Promise<ScheduleFollowUpResult> {
    if (!(await this.isEnabled())) return { scheduled: false, reason: 'disabled' };
    // anchorEventId 必须进幂等键：同一工单后续改约会产生新锚点，需要重新查询并按新时间排程；
    // 若只按 workOrderId 去重，已完成的首次解析任务会吞掉改约后的解析任务。
    const jobId = `${input.sessionRef.sessionId}:${input.scenarioCode}:${input.anchorEventId}:resolve`;
    try {
      await this.queue.add(
        REENGAGEMENT_JOB_NAME,
        {
          sessionRef: input.sessionRef,
          scenarioCode: input.scenarioCode,
          workOrderId: input.workOrderId,
          anchorEventId: input.anchorEventId,
          anchorAt: input.anchorAt,
          resolveBookingAtFire: true,
          ...(input.channelIdentity ? { channelIdentity: input.channelIdentity } : {}),
        },
        {
          jobId,
          attempts: 6,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
        },
      );
      this.logger.log(`[reengagement] 已排面试排程解析重试 jobId=${jobId}`);
      return { scheduled: true, fireAt: Date.now(), jobId };
    } catch (error) {
      this.logger.error(
        `[reengagement] 面试排程解析任务排程失败 jobId=${jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { scheduled: false, reason: 'booking_resolution_schedule_error', jobId };
    }
  }

  async removePendingJob(jobId: string, reason?: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return false;
      const state = await job.getState();
      if (state === 'stuck' || !PENDING_JOB_STATUSES.includes(state)) {
        this.logger.debug(
          `[reengagement] jobId=${jobId} 当前状态=${state}，不是待触发任务，跳过 superseded 标记`,
        );
        return false;
      }
      await job.remove();
      this.trackRemovedPendingJob(job, jobId, undefined, reason ?? 'superseded');
      this.logger.log(
        `[reengagement] 已移除未触发任务 jobId=${jobId}${reason ? ` reason=${reason}` : ''}`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `[reengagement] 移除任务失败 jobId=${jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async removeSupersededPendingJobs(input: {
    sessionRef: SessionRef;
    scenarioCode: FollowUpScenarioCode;
    reason?: string;
  }): Promise<number> {
    const scenario = getScenario(input.scenarioCode);
    if (!scenario?.supersedes?.length) return 0;
    let removed = 0;
    for (const targetCode of scenario.supersedes) {
      const target = getScenario(targetCode);
      const anchorEventId = target?.canonicalAnchorEventId;
      if (!anchorEventId) continue;
      const jobId = this.buildJobId(input.sessionRef.sessionId, targetCode, anchorEventId);
      const ok = await this.removePendingJob(
        jobId,
        input.reason ?? `${input.scenarioCode}_supersedes_${targetCode}`,
      );
      if (ok) removed += 1;
    }
    return removed;
  }

  private async removeSupersededPendingJobsBeforeEnqueue(
    input: ScheduleFollowUpInput,
    scenario: FollowUpScenario,
    currentJobId: string,
  ): Promise<{ removed: number; blockedByBookingIncomplete: boolean }> {
    let pendingJobs: Array<Job<FollowUpJob>> = [];
    try {
      pendingJobs = await this.queue.getJobs(PENDING_JOB_STATUSES, 0, -1, true);
    } catch (error) {
      this.logger.warn(
        `[reengagement] 查询待触发任务失败，跳过旧任务清理 sessionId=${input.sessionRef.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { removed: 0, blockedByBookingIncomplete: false };
    }

    const blockedByBookingIncomplete = pendingJobs.some(
      (job) =>
        input.scenarioCode !== 'booking_incomplete' &&
        scenario.phase === 'pre_booking' &&
        job.data?.sessionRef.sessionId === input.sessionRef.sessionId &&
        job.data.scenarioCode === 'booking_incomplete',
    );
    if (blockedByBookingIncomplete) {
      this.logger.debug(`[reengagement] 收资任务优先，跳过低阶任务 ${currentJobId}`);
      return { removed: 0, blockedByBookingIncomplete: true };
    }

    let removed = 0;
    for (const job of pendingJobs) {
      const jobId = String(job.id);
      if (jobId === currentJobId) continue;
      if (!this.shouldRemovePendingJob(input, scenario, job.data)) continue;
      try {
        await job.remove();
        this.trackRemovedPendingJob(
          job,
          jobId,
          currentJobId,
          `${input.scenarioCode}_supersedes_pending`,
        );
        removed += 1;
        this.logger.log(`[reengagement] 新任务 ${currentJobId} 已移除旧待触发任务 jobId=${jobId}`);
      } catch (error) {
        this.logger.warn(
          `[reengagement] 移除旧待触发任务失败 jobId=${jobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { removed, blockedByBookingIncomplete: false };
  }

  private trackRemovedPendingJob(
    job: Job<FollowUpJob>,
    jobId: string,
    supersededByJobId?: string,
    reason?: string,
  ): void {
    const identity = this.buildIdentityFromJobData(job.data);
    if (!identity) return;
    this.tracking.trackSuperseded(identity, { jobId, supersededByJobId, reason });
  }

  private buildIdentityFromJobData(
    jobData: FollowUpJob | undefined,
  ): ReengagementTouchIdentity | null {
    if (!jobData) return null;
    return {
      sessionId: jobData.sessionRef.sessionId,
      userId: jobData.sessionRef.userId,
      corpId: jobData.sessionRef.corpId,
      scenarioCode: jobData.scenarioCode,
      anchorEventId: jobData.anchorEventId,
      anchorAt: jobData.anchorAt,
      ...jobData.channelIdentity,
    };
  }

  private shouldRemovePendingJob(
    input: ScheduleFollowUpInput,
    scenario: FollowUpScenario,
    candidate: FollowUpJob | undefined,
  ): boolean {
    if (!candidate || candidate.sessionRef.sessionId !== input.sessionRef.sessionId) return false;
    const candidateScenario = getScenario(candidate.scenarioCode);
    if (!candidateScenario) return false;

    if (scenario.phase === 'pre_booking') {
      // 收资开始后，候选人可能继续追问已选岗位的薪资、排班或福利。此类释疑产生的
      // 低阶锚点不能覆盖 booking_incomplete；只有新的收资锚点或报名后场景才能收敛它。
      if (
        candidate.scenarioCode === 'booking_incomplete' &&
        input.scenarioCode !== 'booking_incomplete'
      ) {
        return false;
      }
      return candidateScenario.phase === 'pre_booking';
    }

    if (candidateScenario.phase === 'pre_booking') return true;
    return !this.isSameBookingSlot(input, candidate);
  }

  private isSameBookingSlot(input: ScheduleFollowUpInput, candidate: FollowUpJob): boolean {
    return (
      input.workOrderId != null &&
      candidate.workOrderId === input.workOrderId &&
      input.expectedInterviewAt != null &&
      candidate.expectedInterviewAt === input.expectedInterviewAt
    );
  }

  private buildJobId(
    sessionId: string,
    scenarioCode: FollowUpScenarioCode,
    anchorEventId: string,
  ): string {
    return `${sessionId}:${scenarioCode}:${anchorEventId}`;
  }
}

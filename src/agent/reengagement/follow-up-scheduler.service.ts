import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { SessionRef } from '../runner/agent-runner.types';
import {
  REENGAGEMENT_JOB_NAME,
  REENGAGEMENT_QUEUE,
  type FollowUpJob,
  type FollowUpScenarioCode,
  type ReengagementChannelIdentity,
} from './reengagement.types';
import { computeFireAt, getScenario, shouldStop } from './scenario-registry';

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
  /** 排程时冻结的期望面试时间（毫秒，改期比对基准）。 */
  expectedInterviewAt?: number;
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

export interface ScheduleFollowUpResult {
  scheduled: boolean;
  reason?: string;
  fireAt?: number;
  jobId?: string;
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

    const fireAt = computeFireAt(scenario, { anchorAt: input.anchorAt, state });
    const delay = Math.max(0, fireAt - Date.now());
    const jobId = `${input.sessionRef.sessionId}:${input.scenarioCode}:${input.anchorEventId}`;

    try {
      await this.queue.add(
        REENGAGEMENT_JOB_NAME,
        {
          sessionRef: input.sessionRef,
          scenarioCode: input.scenarioCode,
          anchorEventId: input.anchorEventId,
          anchorAt: input.anchorAt,
          ...(input.workOrderId != null ? { workOrderId: input.workOrderId } : {}),
          ...(input.expectedInterviewAt != null
            ? { expectedInterviewAt: input.expectedInterviewAt }
            : {}),
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
}

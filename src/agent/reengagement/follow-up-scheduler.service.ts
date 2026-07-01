import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { SessionRef } from '../runner/agent-runner.types';
import {
  REENGAGEMENT_JOB_NAME,
  REENGAGEMENT_QUEUE,
  type FollowUpJob,
  type FollowUpScenarioCode,
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
    private readonly configService: ConfigService,
  ) {}

  /** 总开关：默认开启排程（投递与否由 shadow 控制，见 processor）。 */
  private isEnabled(): boolean {
    return this.configService.get<string>('REENGAGEMENT_ENABLED', 'true') !== 'false';
  }

  async scheduleFollowUp(input: ScheduleFollowUpInput): Promise<ScheduleFollowUpResult> {
    if (!this.isEnabled()) return { scheduled: false, reason: 'disabled' };

    const scenario = getScenario(input.scenarioCode);
    if (!scenario) return { scheduled: false, reason: 'unknown_scenario' };

    const state = input.state ?? createEmptyState();

    // 排程前停止条件预检（仅当提供了 state）——能省一个无效 delayed job；
    // 缺 state 时跳过预检，processor 到点会读权威态再做完整 shouldStop。
    if (input.state) {
      const stop = shouldStop(scenario, input.state, input.anchorAt);
      if (stop.stop) return { scheduled: false, reason: stop.reason };
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
      return { scheduled: true, fireAt, jobId };
    } catch (error) {
      this.logger.error(
        `[reengagement] 排程失败 jobId=${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { scheduled: false, reason: 'enqueue_error' };
    }
  }
}

import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bull';
import { MemoryConfig } from '../memory.config';

export const MEMORY_CONSOLIDATION_QUEUE = 'memory-consolidation';
export const MEMORY_CONSOLIDATION_JOB = 'consolidate-idle-session';

export interface MemoryConsolidationJob {
  corpId: string;
  userId: string;
  sessionId: string;
  /** 长期记忆关系维：企业托管账号稳定 wecomUserId。 */
  botUserId?: string;
  /** 当前托管账号 wxid，仅保留为事实血缘/排障字段，不参与主键。 */
  botImId?: string;
  /** 注册/刷新任务时的回合结束时间，用于识别在途旧任务。 */
  activityAt: number;
}

@Injectable()
export class ConsolidationSchedulerService {
  private readonly logger = new Logger(ConsolidationSchedulerService.name);

  constructor(
    @InjectQueue(MEMORY_CONSOLIDATION_QUEUE)
    private readonly queue: Queue<MemoryConsolidationJob>,
    private readonly config: MemoryConfig,
  ) {}

  /**
   * 每回合结束刷新同一 chat 的 delayed job。正常路径复用固定 jobId 并先移除旧任务；
   * 极小概率遇到旧任务已 active 时，另排一个带 activityAt 的接替任务，旧任务会在
   * 到点闲置校验中 fail closed。
   */
  async schedule(input: MemoryConsolidationJob, delayMs?: number): Promise<string> {
    const baseJobId = this.buildJobId(input.sessionId);
    let jobId = baseJobId;
    const existing = await this.queue.getJob(baseJobId).catch(() => null);

    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state === 'active') {
        jobId = `${baseJobId}:${input.activityAt}`;
      } else {
        await existing.remove();
      }
    }

    const delay = Math.max(0, delayMs ?? this.config.consolidationGapSeconds * 1000);
    await this.queue.add(MEMORY_CONSOLIDATION_JOB, input, {
      jobId,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5 * 60 * 1000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 500 },
    });

    this.logger.debug(
      `[memory-consolidation] 已排程: sessionId=${input.sessionId}, delayMs=${delay}, jobId=${jobId}`,
    );
    return jobId;
  }

  private buildJobId(sessionId: string): string {
    return `memory-consolidation:${sessionId}`;
  }
}

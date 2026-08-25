import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { AlertLevel } from '@enums/alert.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { SessionStateService } from '../short-term/session-state.service';
import { ConsolidationService } from './consolidation.service';
import {
  MEMORY_CONSOLIDATION_JOB,
  MEMORY_CONSOLIDATION_QUEUE,
  type MemoryConsolidationJob,
  ConsolidationSchedulerService,
} from './consolidation-scheduler.service';

@Injectable()
export class ConsolidationProcessor implements OnModuleInit {
  private readonly logger = new Logger(ConsolidationProcessor.name);

  constructor(
    @InjectQueue(MEMORY_CONSOLIDATION_QUEUE)
    private readonly queue: Queue<MemoryConsolidationJob>,
    private readonly session: SessionStateService,
    private readonly consolidation: ConsolidationService,
    private readonly scheduler: ConsolidationSchedulerService,
    private readonly incidents: IncidentReporterService,
  ) {}

  onModuleInit(): void {
    this.queue.process(MEMORY_CONSOLIDATION_JOB, 2, (job: Job<MemoryConsolidationJob>) =>
      this.process(job),
    );
    this.logger.log('[memory-consolidation] processor 已注册');
  }

  async process(job: Job<MemoryConsolidationJob>): Promise<void> {
    const { corpId, userId, sessionId, botUserId, botImId } = job.data;
    try {
      if (!botUserId) {
        throw new Error(`memory_consolidation_bot_user_id_missing:${sessionId}`);
      }
      const state = await this.session.getSessionState(corpId, userId, sessionId);
      const result = await this.consolidation.settleIdleSession(
        corpId,
        userId,
        sessionId,
        botUserId,
        state.facts ?? null,
        botImId,
        state.facts?.brand ?? null,
      );

      if (result.status === 'not_idle') {
        await this.scheduler.schedule(
          {
            ...job.data,
            activityAt: result.latestMessageAt,
          },
          result.retryDelayMs,
        );
      }
    } catch (error) {
      if (this.isFinalAttempt(job)) {
        await this.incidents.notify({
          code: 'memory.consolidation_failed',
          summary: '会话记忆定时沉淀重试耗尽',
          severity: AlertLevel.ERROR,
          source: {
            subsystem: 'memory',
            component: 'ConsolidationProcessor',
            action: 'process',
            trigger: 'queue',
          },
          scope: { userId, sessionId },
          error,
          diagnostics: {
            errorMessage: toErrorMessage(error),
            totalAttempts: job.opts.attempts ?? 1,
            payload: { corpId, userId, sessionId, botUserId, botImId },
          },
          dedupe: { key: `memory.consolidation_failed:${corpId}:${sessionId}` },
        });
      }
      throw error;
    }
  }

  private isFinalAttempt(job: Job<MemoryConsolidationJob>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  }
}

import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { AlertLevel } from '@enums/alert.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { SessionSemanticService } from '../short-term/session-semantic.service';
import { ConsolidationService } from './consolidation.service';
import {
  MEMORY_SETTLEMENT_JOB,
  MEMORY_SETTLEMENT_QUEUE,
  type MemorySettlementJob,
  SettlementSchedulerService,
} from './settlement-scheduler.service';

@Injectable()
export class SettlementProcessor implements OnModuleInit {
  private readonly logger = new Logger(SettlementProcessor.name);

  constructor(
    @InjectQueue(MEMORY_SETTLEMENT_QUEUE)
    private readonly queue: Queue<MemorySettlementJob>,
    private readonly session: SessionSemanticService,
    private readonly consolidation: ConsolidationService,
    private readonly scheduler: SettlementSchedulerService,
    private readonly incidents: IncidentReporterService,
  ) {}

  onModuleInit(): void {
    this.queue.process(MEMORY_SETTLEMENT_JOB, 2, (job: Job<MemorySettlementJob>) =>
      this.process(job),
    );
    this.logger.log('[memory-settlement] processor 已注册');
  }

  async process(job: Job<MemorySettlementJob>): Promise<void> {
    const { corpId, userId, sessionId, botImId } = job.data;
    try {
      const state = await this.session.getSessionState(corpId, userId, sessionId);
      const result = await this.consolidation.settleIdleSession(
        corpId,
        userId,
        sessionId,
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
          code: 'memory.settlement_failed',
          summary: '会话记忆定时沉淀重试耗尽',
          severity: AlertLevel.ERROR,
          source: {
            subsystem: 'memory',
            component: 'SettlementProcessor',
            action: 'process',
            trigger: 'queue',
          },
          scope: { userId, sessionId },
          error,
          diagnostics: {
            errorMessage: toErrorMessage(error),
            totalAttempts: job.opts.attempts ?? 1,
            payload: { corpId, userId, sessionId, botImId },
          },
          dedupe: { key: `memory.settlement_failed:${corpId}:${sessionId}` },
        });
      }
      throw error;
    }
  }

  private isFinalAttempt(job: Job<MemorySettlementJob>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  }
}

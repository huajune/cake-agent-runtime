import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyWorkflowService } from '../application/reply-workflow.service';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';

/** Durable scan repairs original plans/acks, including after the Redis input TTL expires. */
@Injectable()
export class ReplyRecoveryService {
  private readonly logger = new Logger(ReplyRecoveryService.name);
  private running = false;
  constructor(
    private readonly turns: ReplyTurnsService,
    private readonly workflow: ReplyWorkflowService,
    private readonly leases: ReplyRecoveryLeaseService,
    private readonly config: ConfigService,
    private readonly crons: CronRunnerService,
    @Optional() private readonly incidents?: IncidentReporterService,
  ) {}

  @Cron('*/1 * * * *')
  async recoverDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const deadline = Date.now() + 30_000;
    try {
      for (const turn of await this.turns.repository.due()) {
        if (Date.now() >= deadline) break;
        // Proactive tasks own their domain follow-up and reuse only delivery plans.
        if (!turn.recovery.primary) continue;
        await this.leases.run(turn.chatId, async (assertOwned) => {
          try {
            if (!turn.plan && turn.status === 'preparing') {
              this.logger.error(
                `reply.manual_review_required generation_interrupted ${turn.logicalTurnId}`,
              );
              this.manualReview(turn.logicalTurnId, 'generation_interrupted');
              return;
            }
            const primary = turn.recovery.primary as { _apiType?: string };
            if (turn.status === 'planned' && primary._apiType === 'group') {
              // No persisted group credential and no verified resolver: never switch accounts/APIs.
              this.logger.warn(`reply.manual_credential_resolution ${turn.logicalTurnId}`);
              this.manualReview(turn.logicalTurnId, 'group_credential_resolution');
              return;
            }
            const token = this.config.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() ?? '';
            if (!token && turn.status === 'planned') return;
            await this.workflow.resumePersistedReply(turn, token, assertOwned);
          } catch {
            this.logger.warn(`reply.recovery_pending ${turn.logicalTurnId}`);
            if (
              turn.status === 'planned' &&
              Date.parse(turn.inputOccurredAt) < Date.now() - 86400_000
            ) {
              this.manualReview(turn.logicalTurnId, 'recovery_deadline');
            }
          } finally {
            await assertOwned();
            await this.turns.defer(turn);
          }
        });
      }
    } catch {
      this.logger.error('reply.recovery_scan_failed');
    } finally {
      this.running = false;
    }
  }

  @Cron('47 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async retainTombstones(): Promise<void> {
    await this.crons.runBatches(
      'reply-retention',
      { timeMs: 30_000, maxRows: 10_000, batchSize: 100 },
      (limit) => this.turns.repository.redact(limit),
    );
  }

  private manualReview(logicalTurnId: string, reason: string): void {
    this.incidents?.notifyAsync({
      source: {
        subsystem: 'reply-execution',
        component: 'ReplyRecoveryService',
        action: 'recover',
        trigger: 'cron',
      },
      code: 'reply.manual_review_required',
      summary: '回复计划需要人工核实，未重新发送',
      error: new Error(`${logicalTurnId}: ${reason}`),
      dedupe: { key: `reply.manual_review_required:${logicalTurnId}` },
    });
  }
}

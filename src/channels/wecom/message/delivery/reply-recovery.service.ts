import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { BusinessTenantResolver, runForTenant } from '@infra/supabase/business-tenant';
import { Injectable, Logger } from '@nestjs/common';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { Cron, Timeout } from '@nestjs/schedule';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyWorkflowService } from '../application/reply-workflow.service';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import {
  REPLY_TURN_STATUS,
  REPLY_DELIVERY_OUTCOME,
  REPLY_PROJECTION_STATUS,
  REPLY_REVIEW_REASON,
} from '@biz/reply-execution/reply-execution.constants';
import { CRON_JOB } from '@infra/queue/cron.constants';

/** Takes over expired ordinary deliveries and repairs their original input and business effects. */
@Injectable()
export class ReplyRecoveryService {
  private readonly logger = new Logger(ReplyRecoveryService.name);
  private running = false;
  constructor(
    private readonly turns: ReplyTurnsService,
    private readonly workflow: ReplyWorkflowService,
    private readonly leases: ReplyRecoveryLeaseService,
    private readonly crons: CronRunnerService,
    private readonly incidents: IncidentReporterService,
    private readonly tenants: BusinessTenantResolver,
  ) {}

  /** A restarted instance should not spend its remaining sending window waiting for a cron tick. */
  @Timeout(0)
  recoverOnStartup(): Promise<void> {
    return this.recoverDue();
  }

  @Cron('*/1 * * * *')
  async recoverDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const deadline = Date.now() + 30_000;
    try {
      for (const turn of await this.turns.repository.due()) {
        if (Date.now() >= deadline) break;
        // Historical proactive turns have no primary input; their domain owns follow-up.
        if (!turn.recovery.primary) continue;
        await this.leases
          .run(turn.chatId, (assertOwned) => this.resumeTurn(turn, assertOwned))
          .catch((error: unknown) => {
            this.logger.warn(
              `reply.recovery_lease_or_store_unavailable ${turn.logicalTurnId}: ${String(error)}`,
            );
          });
      }
    } catch {
      this.logger.error('reply.recovery_scan_failed');
    } finally {
      this.running = false;
    }
  }

  private async resumeTurn(turn: ReplyTurn, assertOwned: () => Promise<void>): Promise<void> {
    // Re-read under the SQL lock. A live owner may have renewed or completed since due() ran.
    await assertOwned();
    let current = turn;
    try {
      if (
        turn.recovery.replySegments &&
        (turn.status === REPLY_TURN_STATUS.PLANNED || turn.status === REPLY_TURN_STATUS.PREPARING)
      ) {
        current = await this.turns.resumeDelivery(turn);
        if (current.status === REPLY_TURN_STATUS.PLANNED)
          current = await this.inOriginalTenant(current, () =>
            this.workflow.resumeDelivery(current, assertOwned),
          );
      } else {
        current = await this.turns.interrupt(turn);
      }
      await this.finishRecovery(current, assertOwned);
    } catch (error) {
      this.logger.warn(`reply.recovery_pending ${turn.logicalTurnId}: ${String(error)}`);
      await assertOwned();
      await this.turns.defer(current);
    }
  }

  private async finishRecovery(
    terminal: ReplyTurn,
    assertOwned: () => Promise<void>,
  ): Promise<void> {
    const unknown = terminal.projectionStatus === REPLY_PROJECTION_STATUS.NONE;
    const reason = unknown
      ? REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED
      : terminal.deliveryResult?.outcome === REPLY_DELIVERY_OUTCOME.INTERRUPTED
        ? REPLY_REVIEW_REASON.INTERRUPTED
        : undefined;
    if (reason && !terminal.reviewReason)
      terminal = await this.turns.requestReview(terminal, reason);
    try {
      if (!unknown && terminal.status !== REPLY_TURN_STATUS.ACKED)
        await this.inOriginalTenant(terminal, () =>
          this.workflow.resumeInputCompletion(terminal, assertOwned),
        );
    } catch (error) {
      if (!terminal.reviewReason && Date.parse(terminal.inputOccurredAt) < Date.now() - 86400_000)
        terminal = await this.turns.requestReview(terminal, REPLY_REVIEW_REASON.RECOVERY_DEADLINE);
      throw error;
    } finally {
      if (terminal.reviewRequired && !terminal.reviewNotifiedAt && terminal.reviewReason) {
        await assertOwned();
        await this.notifyReview(terminal);
        await assertOwned();
        await this.turns.reviewNotified(terminal);
      }
    }
  }

  private async inOriginalTenant<T>(turn: ReplyTurn, work: () => Promise<T>): Promise<T> {
    let tenantId = turn.recovery.tenantId;
    if (tenantId === undefined) {
      // Older turns store the earliest input time. A merged turn has no matching timestamp per ID.
      [tenantId] = await this.tenants.resolve([
        {
          botId: turn.accountId,
          at: Date.parse(turn.inputOccurredAt),
          messageId: turn.inputIds.length === 1 ? turn.inputIds[0] : undefined,
        },
      ]);
    }
    if (typeof tenantId !== 'string' || !tenantId.trim())
      throw new ReplyDeferredError('original_reply_tenant_unconfirmed');
    return runForTenant(tenantId, work);
  }

  @Cron('47 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async retainTombstones(): Promise<void> {
    await this.crons.runBatches(
      CRON_JOB.REPLY_RETENTION,
      { timeMs: 30_000, maxRows: 10_000, batchSize: 100 },
      (limit) => this.turns.repository.redact(limit),
    );
  }

  private async notifyReview(turn: ReplyTurn): Promise<void> {
    const summaries = {
      [REPLY_REVIEW_REASON.PROVIDER_OUTAGE]:
        '模型服务不可用，候选人尚未收到回复。本轮未执行工具，请人工接续对话',
      [REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED]:
        '回复已中断，业务结果未保存。请核对本轮的工单、群邀请及发送记录',
      [REPLY_REVIEW_REASON.INTERRUPTED]: '回复在投递完成前中断。请核对已受理的消息分段',
      [REPLY_REVIEW_REASON.RECOVERY_DEADLINE]:
        '回复超过自动恢复期限。请核对原回复、分段受理凭证和本轮业务补账，确认是否需要人工接续',
    };
    const reason = turn.reviewReason!;
    const delivered = await this.incidents.notify({
      source: {
        subsystem: 'reply-execution',
        component: 'ReplyRecoveryService',
        action: 'recover',
        trigger: 'cron',
      },
      code: 'reply.manual_review_required',
      summary: summaries[reason],
      error: `${turn.logicalTurnId}: ${reason}`,
      scope: {
        corpId: turn.corpId,
        chatId: turn.chatId,
        messageId:
          typeof turn.recovery.traceId === 'string' ? turn.recovery.traceId : turn.inputIds[0],
      },
      impact: { requiresHumanIntervention: true },
      diagnostics: {
        category: reason,
        messageCount: turn.inputIds.length,
        payload: {
          logicalTurnId: turn.logicalTurnId,
          inputOccurredAt: turn.inputOccurredAt,
          inputMessageIds: turn.inputIds,
          delivery: turn.deliveryResult?.outcome,
          projection: turn.projectionStatus,
          failure: turn.recovery.failure,
        },
      },
      dedupe: { key: `reply.manual_review_required:${turn.logicalTurnId}` },
    });
    if (!delivered) throw new Error('review_notification_unconfirmed');
  }
}

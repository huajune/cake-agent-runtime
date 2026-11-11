import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { ConfigService } from '@nestjs/config';
import { GroupRouteCredentialsService } from '../credentials/group-route-credentials.service';
import { Cron } from '@nestjs/schedule';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyWorkflowService } from '../application/reply-workflow.service';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';
import type { ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import {
  REPLY_TURN_STATUS,
  REPLY_DELIVERY_POLICY,
  REPLY_DELIVERY_OUTCOME,
  REPLY_PROJECTION_STATUS,
  REPLY_REVIEW_REASON,
} from '@biz/reply-execution/reply-execution.constants';
import { CRON_JOB } from '@infra/queue/cron.constants';
import { WECOM_API_TYPE } from '@shared-types/wecom-api.types';

/** Repairs input ACKs/local projections; only historical frozen turns resume a saved send plan. */
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
    @Optional() private readonly groupCredentials?: GroupRouteCredentialsService,
  ) {}

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
        await this.leases.run(turn.chatId, async (assertOwned) => {
          try {
            await this.resumeTurn(turn, assertOwned);
          } catch {
            this.logger.warn(`reply.recovery_pending ${turn.logicalTurnId}`);
            if (
              turn.status === REPLY_TURN_STATUS.PLANNED &&
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

  private async resumeTurn(turn: ReplyTurn, assertOwned: () => Promise<void>): Promise<void> {
    if (turn.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS) {
      if (turn.projectionStatus === REPLY_PROJECTION_STATUS.NONE) {
        // 生成或业务结果保存中断：无法证明是否有已成功的报名/改约，不能吞掉原输入。
        this.manualReview(turn.logicalTurnId, REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED);
        return;
      }
      const terminal = await this.turns.interrupt(turn);
      if (terminal.deliveryResult?.outcome === REPLY_DELIVERY_OUTCOME.INTERRUPTED)
        this.manualReview(turn.logicalTurnId, 'ordinary_reply_interrupted_no_resend');
      await this.workflow.resumePersistedReply(terminal, '', assertOwned);
      return;
    }
    if (!turn.plan && turn.status === REPLY_TURN_STATUS.PREPARING) {
      this.logger.error(
        `reply.manual_review_required generation_interrupted ${turn.logicalTurnId}`,
      );
      this.manualReview(turn.logicalTurnId, 'generation_interrupted');
      return;
    }
    const primary = turn.recovery.primary as {
      _apiType?: string;
      orgId?: string;
      imBotId?: string;
      chatId?: string;
      groupId?: string;
    };
    let token = '';
    if (turn.status === REPLY_TURN_STATUS.PLANNED) {
      if (
        primary.orgId !== turn.corpId ||
        primary.imBotId !== turn.accountId ||
        primary.chatId !== turn.chatId
      ) {
        this.manualReview(turn.logicalTurnId, 'recovery_identity_mismatch');
        return;
      }
      if (primary._apiType === WECOM_API_TYPE.GROUP) {
        const route = await this.groupCredentials?.resolveForRecovery({
          corpId: turn.corpId,
          accountId: turn.accountId,
          groupId: primary.groupId,
        });
        if (!route) {
          this.manualReview(turn.logicalTurnId, 'group_credential_resolution');
          return;
        }
        token = route.token;
      } else {
        token = this.config.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() ?? '';
        if (!token) return;
      }
    }
    await this.workflow.resumePersistedReply(turn, token, assertOwned);
  }

  @Cron('47 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async retainTombstones(): Promise<void> {
    await this.crons.runBatches(
      CRON_JOB.REPLY_RETENTION,
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

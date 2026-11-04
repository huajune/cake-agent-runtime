import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { Cron } from '@nestjs/schedule';
import { ActionLocalSyncService } from './action-local-sync.service';
import { ActionRecordsRepository } from './action-records.repository';
import { ActionRecoveryRegistry } from './action-recovery.registry';
import type { ActionRecord } from './action-execution.types';
import { CRON_JOB } from '@infra/queue/cron.constants';
import { ACTION_STATE } from '@shared-types/action-execution.contract';

@Injectable()
export class ActionRecoveryService {
  private readonly logger = new Logger(ActionRecoveryService.name);
  private running = false;

  constructor(
    private readonly records: ActionRecordsRepository,
    private readonly handlers: ActionRecoveryRegistry,
    private readonly localSync: ActionLocalSyncService,
    private readonly crons: CronRunnerService,
    @Optional() private readonly incidents?: IncidentReporterService,
  ) {}

  @Cron('*/1 * * * *')
  async recoverDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const deadline = Date.now() + 30_000;
    try {
      for (const due of await this.records.due(25)) {
        if (Date.now() >= deadline) break;
        try {
          const record = await this.records.claim(due, randomUUID(), true);
          if (record) await this.recover(record);
        } catch {
          this.logger.error(`action.recovery_storage_error ${due.actionId}`);
        }
      }
    } catch {
      this.logger.error('action.recovery_scan_failed');
    } finally {
      this.running = false;
    }
  }

  @Cron('17 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async retainTombstones(): Promise<void> {
    await this.crons.runBatches(
      CRON_JOB.ACTION_RETENTION,
      { timeMs: 30_000, maxRows: 10_000, batchSize: 100 },
      (limit) => this.records.redactCompleted(limit),
    );
  }

  private async recover(record: ActionRecord): Promise<void> {
    const handler = this.handlers.get(record.intent.kind);
    try {
      if (record.status === ACTION_STATE.SUCCEEDED) {
        if (!handler || record.attempts > 6 || Date.now() >= Date.parse(record.recoveryDeadline)) {
          await this.requestReview(record);
          return;
        }
        await this.localSync.run(record, handler);
        await this.records.markSynced(record);
        return;
      }
      // Deadlines limit automatic queries, never the acceptance of a late terminal callback.
      const late = await this.records.terminalEvidence(record);
      if (late.conflicting) {
        await this.requestReview(record);
        return;
      }
      if (
        !late.completion &&
        (!handler || record.attempts > 6 || Date.now() >= Date.parse(record.recoveryDeadline))
      ) {
        await this.requestReview(record);
        return;
      }
      const completion =
        late.completion ?? (await this.queryWithinBudget(() => handler!.reconcile(record)));
      const settled = await this.records.settle(record, completion);
      if (settled.status === ACTION_STATE.SUCCEEDED) {
        if (!handler) {
          await this.requestReview(settled);
          return;
        }
        await this.localSync.run(settled, handler);
        await this.records.markSynced(settled);
      } else if (
        settled.status === ACTION_STATE.UNKNOWN ||
        settled.status === ACTION_STATE.EXECUTING
      ) {
        await this.records.defer(settled, this.nextCheck(settled));
      }
    } catch {
      // Query failure is not definitive absence and never authorizes a new dispatch.
      await this.records.defer(record, this.nextCheck(record));
      this.logger.warn(`action.reconciliation_pending ${record.actionId}`);
    }
  }

  private async queryWithinBudget<T>(query: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        query(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('action_reconciliation_query_timeout')), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async requestReview(record: ActionRecord): Promise<void> {
    this.logger.error(`action.manual_review_required ${record.actionId} status=${record.status}`);
    const delivered = await this.queryWithinBudget(
      async () =>
        this.incidents?.notify({
          source: {
            subsystem: 'action-execution',
            component: 'ActionRecoveryService',
            action: 'reconcile',
            trigger: 'cron',
          },
          code: 'action.manual_review_required',
          summary: '外部动作无法自动核实，需要人工处理',
          error: new Error(`Action ${record.actionId} remains ${record.status}`),
          dedupe: { key: `action.manual_review_required:${record.actionId}` },
        }) ?? false,
    ).catch(() => false);
    // Stop scanning only after the existing notification channel confirms delivery.
    // An unavailable/throttled channel must not strand an unknown action forever.
    await this.records.defer(record, delivered ? null : this.nextCheck(record, false));
  }

  private nextCheck(record: ActionRecord, limitByRecoveryDeadline = true): string {
    return new Date(
      Math.min(
        Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** record.attempts),
        limitByRecoveryDeadline ? Date.parse(record.recoveryDeadline) : Infinity,
      ),
    ).toISOString();
  }
}

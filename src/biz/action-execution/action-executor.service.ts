import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionRecordsRepository } from './action-records.repository';
import { identifyAction } from './action-identity';
import { ActionRepairQueue } from './action-repair.queue';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import type {
  ActionCallbacks,
  ActionCompletion,
  ActionExecution,
  ActionIntent,
  ActionMode,
  ActionRecord,
} from './action-execution.types';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);
  private readonly mode: ActionMode;
  /** Keep this boundary when rolling back the mode; it latches fail-closed recovery. */
  private readonly cutoverAt: number | null;

  constructor(
    private readonly records: ActionRecordsRepository,
    config: ConfigService,
    @Optional() private readonly repair?: ActionRepairQueue,
    @Optional() private readonly incidents?: IncidentReporterService,
  ) {
    const mode = config.get<string>('ACTION_EXECUTION_MODE', 'observe');
    if (!['off', 'observe', 'execute'].includes(mode))
      throw new Error('Invalid ACTION_EXECUTION_MODE');
    this.mode = mode as ActionMode;
    const boundary = config.get<string>('ACTION_EXECUTION_CUTOVER_AT');
    this.cutoverAt = boundary ? Date.parse(boundary) : null;
    if (
      (this.cutoverAt !== null && !Number.isFinite(this.cutoverAt)) ||
      (this.mode === 'execute' && this.cutoverAt === null)
    ) {
      throw new Error(
        'Execute mode requires ACTION_EXECUTION_CUTOVER_AT; preserve it during rollback',
      );
    }
  }

  async execute<T>(
    intent: ActionIntent,
    callbacks: ActionCallbacks<T>,
  ): Promise<ActionExecution<T>> {
    let identity: ReturnType<typeof identifyAction>;
    try {
      identity = identifyAction(intent);
    } catch {
      return {
        actionId: '',
        requestId: '',
        status: 'blocked',
        localSync: 'complete',
        dispatched: false,
        reason: 'invalid_action_identity',
      };
    }
    const blocked = (reason: string): ActionExecution<T> => ({
      ...identity,
      status: 'blocked',
      localSync: 'complete',
      dispatched: false,
      reason,
    });
    const occurredAt = Date.parse(intent.occurredAt);
    if (occurredAt < Date.now() - RETENTION_MS || occurredAt > Date.now() + 60_000)
      return blocked('expired_or_invalid_input');
    if (this.mode === 'execute' && (!intent.identityReliable || occurredAt < this.cutoverAt!))
      return blocked('input_before_cutover_or_identity_not_persisted');

    let record: ActionRecord | null = null;
    try {
      const prepared = await this.records.prepare(intent, this.mode);
      record = prepared.record;
      if (prepared.conflict) {
        if (
          prepared.conflict === 'identity_payload_mismatch' &&
          this.mode === 'observe' &&
          record?.mode !== 'execute' &&
          this.cutoverAt === null
        ) {
          this.logger.warn(`action.would_block payload conflict ${identity.actionId}`);
          return this.untracked(intent, callbacks);
        }
        return blocked(
          prepared.conflict === 'identity_payload_mismatch'
            ? prepared.conflict
            : 'unresolved_resource_action',
        );
      }
    } catch {
      // With a cutover configured, even off/observe must honor old execute obligations.
      if (this.cutoverAt !== null || this.mode === 'execute')
        return blocked('action_store_unavailable');
      this.logger.warn(`action.observe_store_unavailable ${identity.actionId}`);
      return this.untracked(intent, callbacks);
    }

    const enforce = record?.mode === 'execute' || this.mode === 'execute';
    if (enforce && record?.mode !== 'execute')
      return blocked('observation_record_requires_cutover_review');
    if (!record) return this.untracked(intent, callbacks);
    if (enforce && !intent.identityReliable) return blocked('identity_not_persisted');

    if (record.status === 'succeeded') {
      if (!enforce) {
        this.logger.warn(`action.would_block succeeded ${record.actionId}`);
        return this.untracked(intent, callbacks);
      }
      return this.synchronize(record, callbacks, false);
    }
    if (
      record.status === 'executing' ||
      record.status === 'unknown' ||
      record.status === 'cancelled' ||
      (record.status === 'failed' && !record.retryable)
    ) {
      if (!enforce) {
        this.logger.warn(`action.would_block ${record.status} ${record.actionId}`);
        return this.untracked(intent, callbacks);
      }
      return this.existing<T>(record, false);
    }
    if (!(await this.authorized(callbacks))) {
      await this.records.cancel(record).catch(() => false);
      return blocked('permission_or_freshness_changed');
    }

    let claimed: ActionRecord | null;
    try {
      claimed = await this.records.claim(record, randomUUID());
    } catch {
      return enforce ? blocked('claim_not_confirmed') : this.untracked(intent, callbacks);
    }
    if (!claimed)
      return enforce ? blocked('dispatch_owned_elsewhere') : this.untracked(intent, callbacks);
    // Authorization may have changed while waiting for the database claim.
    if (!(await this.authorized(callbacks))) {
      const completion: ActionCompletion<T> = {
        status: 'failed',
        retryable: false,
        evidence: {
          kind: 'definitive_no_effect',
          requestTerminated: true,
          detail: 'permission_changed_before_dispatch',
        },
      };
      await this.save(claimed, completion);
      return blocked('permission_or_freshness_changed');
    }

    try {
      if (!(await this.records.validateClaim(claimed)))
        return enforce ? blocked('dispatch_lease_expired') : this.untracked(intent, callbacks);
    } catch {
      return enforce
        ? blocked('dispatch_ownership_unconfirmed')
        : this.untracked(intent, callbacks);
    }
    const completion = await this.dispatch(claimed.requestId, callbacks, claimed.mode);
    const saved = await this.save(claimed, completion);
    if (completion.status === 'succeeded') {
      // A real external success survives both settlement and projection failures.
      const known: ActionRecord = {
        ...claimed,
        status: 'succeeded',
        result: completion.result,
        evidence: completion.evidence,
        localSync: 'pending',
      };
      if (!saved || saved.status !== 'succeeded')
        return enforce ? this.existing<T>(known, true) : this.synchronize(known, callbacks, true);
      return this.synchronize(saved, callbacks, true);
    }
    return this.existing<T>(
      saved ?? {
        ...claimed,
        status: completion.status,
        result: completion.result,
        evidence: completion.evidence,
      },
      true,
    );
  }

  private async untracked<T>(
    intent: ActionIntent,
    callbacks: ActionCallbacks<T>,
  ): Promise<ActionExecution<T>> {
    const identity = identifyAction(intent);
    if (!(await this.authorized(callbacks)))
      return {
        ...identity,
        status: 'blocked',
        localSync: 'complete',
        dispatched: false,
        reason: 'permission_or_freshness_changed',
      };
    const completion = await this.dispatch(identity.requestId, callbacks, this.mode);
    let localSync: 'complete' | 'pending' = 'complete';
    if (completion.status === 'succeeded' && callbacks.sync) {
      try {
        await callbacks.sync(completion.result);
      } catch {
        localSync = 'pending';
        this.logger.error(`action.untracked_local_sync_failed ${identity.actionId}`);
      }
    }
    return {
      ...identity,
      status: completion.status,
      result: completion.result,
      evidence: completion.evidence,
      localSync,
      dispatched: true,
    };
  }

  private async authorized<T>(callbacks: ActionCallbacks<T>): Promise<boolean> {
    try {
      return callbacks.authorize ? await callbacks.authorize() : true;
    } catch {
      return false;
    }
  }

  private async dispatch<T>(
    requestId: string,
    callbacks: ActionCallbacks<T>,
    mode: ActionMode,
  ): Promise<ActionCompletion<T>> {
    try {
      const result = await callbacks.dispatch(requestId, mode);
      if (result.status === 'succeeded' && !result.evidence.requestTerminated)
        return { ...result, status: 'unknown' };
      if (
        result.status === 'failed' &&
        (result.evidence.kind !== 'definitive_no_effect' || !result.evidence.requestTerminated)
      )
        return { ...result, status: 'unknown' };
      return result;
    } catch {
      return {
        status: 'unknown',
        evidence: {
          kind: 'indeterminate',
          requestTerminated: false,
          detail: 'external_call_did_not_return_terminal_evidence',
        },
      };
    }
  }

  private async save<T>(
    record: ActionRecord,
    completion: ActionCompletion<T>,
  ): Promise<ActionRecord | null> {
    // Retry only the same local evidence write, never the external callback.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.records.settle(record, completion);
      } catch {
        /* Durable executing row remains discoverable. */
      }
    }
    this.logger.error(
      `action.settlement_pending ${record.actionId}; external=${completion.status}`,
    );
    if (record.mode !== 'execute') return null;
    try {
      await this.repair?.enqueue(record, completion);
    } catch {
      this.logger.error(
        `action.repair_enqueue_unconfirmed ${record.actionId}; scanner retains ownership`,
      );
    }
    this.incidents?.notifyAsync({
      source: {
        subsystem: 'action-execution',
        component: 'ActionExecutorService',
        action: 'settle',
        trigger: 'process',
      },
      code: 'action.settlement_pending',
      summary: '外部动作结果待补记，禁止重复派发',
      error: new Error('Action settlement is pending'),
      dedupe: { key: `action.settlement_pending:${record.actionId}` },
    });
    return null;
  }

  private async synchronize<T>(
    record: ActionRecord,
    callbacks: ActionCallbacks<T>,
    dispatched: boolean,
  ): Promise<ActionExecution<T>> {
    if (record.localSync === 'complete') return this.existing<T>(record, dispatched);
    try {
      if (callbacks.sync) await callbacks.sync(record.result as T);
      await this.records.markSynced(record);
      return this.existing<T>({ ...record, localSync: 'complete' }, dispatched);
    } catch {
      this.logger.error(`action.local_sync_pending ${record.actionId}`);
      return this.existing<T>(record, dispatched);
    }
  }

  private existing<T>(record: ActionRecord, dispatched: boolean): ActionExecution<T> {
    return {
      actionId: record.actionId,
      requestId: record.requestId,
      status: record.status,
      result: record.result as T,
      evidence: record.evidence,
      localSync: record.localSync,
      dispatched,
    };
  }
}

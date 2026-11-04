import { randomUUID } from 'crypto';
import { ProviderBusinessError } from '@infra/client-http/provider-business-error';
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
import {
  ACTION_EVIDENCE_KIND,
  ACTION_EXECUTION_STATUS,
  ACTION_MODE,
  ACTION_STATE,
  isActionMode,
  LOCAL_SYNC_STATE,
  type LocalSyncState,
} from '@shared-types/action-execution.contract';

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
    const mode = config.get<string>('ACTION_EXECUTION_MODE', ACTION_MODE.OBSERVE);
    if (!isActionMode(mode)) throw new Error('Invalid ACTION_EXECUTION_MODE');
    this.mode = mode;
    const boundary = config.get<string>('ACTION_EXECUTION_CUTOVER_AT');
    this.cutoverAt = boundary ? Date.parse(boundary) : null;
    if (
      (this.cutoverAt !== null && !Number.isFinite(this.cutoverAt)) ||
      (this.mode === ACTION_MODE.EXECUTE && this.cutoverAt === null)
    ) {
      throw new Error(
        'Execute mode requires ACTION_EXECUTION_CUTOVER_AT; preserve it during rollback',
      );
    }
  }

  async execute<T>(
    intent: ActionIntent,
    callbacks: ActionCallbacks<T>,
    /** Only inherit execute from an already persisted parent plan; never from input. */
    options?: { persistedMode: typeof ACTION_MODE.EXECUTE },
  ): Promise<ActionExecution<T>> {
    const mode = options?.persistedMode ?? this.mode;
    let identity: ReturnType<typeof identifyAction>;
    try {
      identity = identifyAction(intent);
    } catch {
      return {
        actionId: '',
        requestId: '',
        status: ACTION_EXECUTION_STATUS.BLOCKED,
        localSync: LOCAL_SYNC_STATE.COMPLETE,
        dispatched: false,
        reason: 'invalid_action_identity',
      };
    }
    const blocked = (reason: string): ActionExecution<T> => ({
      ...identity,
      status: ACTION_EXECUTION_STATUS.BLOCKED,
      localSync: LOCAL_SYNC_STATE.COMPLETE,
      dispatched: false,
      reason,
    });
    const occurredAt = Date.parse(intent.occurredAt);
    if (occurredAt < Date.now() - RETENTION_MS || occurredAt > Date.now() + 60_000)
      return blocked('expired_or_invalid_input');
    if (
      intent.recoveryWindowStartedAt !== undefined &&
      Date.parse(intent.recoveryWindowStartedAt) > Date.now() + 60_000
    )
      return blocked('invalid_recovery_window');
    if (mode === ACTION_MODE.EXECUTE && this.cutoverAt === null)
      return blocked('persisted_execution_requires_cutover');
    if (mode === ACTION_MODE.EXECUTE && (!intent.identityReliable || occurredAt < this.cutoverAt!))
      return blocked('input_before_cutover_or_identity_not_persisted');

    let record: ActionRecord | null = null;
    try {
      const prepared = await this.records.prepare(intent, mode);
      record = prepared.record;
      if (prepared.conflict) {
        if (
          prepared.conflict === 'identity_payload_mismatch' &&
          mode === ACTION_MODE.OBSERVE &&
          record?.mode !== ACTION_MODE.EXECUTE &&
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
      if (this.cutoverAt !== null || mode === ACTION_MODE.EXECUTE)
        return blocked('action_store_unavailable');
      this.logger.warn(`action.observe_store_unavailable ${identity.actionId}`);
      return this.untracked(intent, callbacks);
    }

    const enforce = record?.mode === ACTION_MODE.EXECUTE || mode === ACTION_MODE.EXECUTE;
    if (enforce && record?.mode !== ACTION_MODE.EXECUTE)
      return blocked('observation_record_requires_cutover_review');
    if (!record) return this.untracked(intent, callbacks);
    if (enforce && !intent.identityReliable) return blocked('identity_not_persisted');

    if (record.status === ACTION_STATE.SUCCEEDED) {
      if (!enforce) {
        this.logger.warn(`action.would_block succeeded ${record.actionId}`);
        return this.untracked(intent, callbacks);
      }
      return this.synchronize(record, callbacks, false);
    }
    if (
      record.status === ACTION_STATE.EXECUTING ||
      record.status === ACTION_STATE.UNKNOWN ||
      record.status === ACTION_STATE.CANCELLED ||
      (record.status === ACTION_STATE.FAILED && !record.retryable)
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
        status: ACTION_STATE.FAILED,
        retryable: false,
        evidence: {
          kind: ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT,
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
    if (completion.status === ACTION_STATE.SUCCEEDED) {
      // A real external success survives both settlement and projection failures.
      const known: ActionRecord = {
        ...claimed,
        status: ACTION_STATE.SUCCEEDED,
        result: completion.result,
        evidence: completion.evidence,
        localSync: LOCAL_SYNC_STATE.PENDING,
      };
      if (!saved || saved.status !== ACTION_STATE.SUCCEEDED)
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
        status: ACTION_EXECUTION_STATUS.BLOCKED,
        localSync: LOCAL_SYNC_STATE.COMPLETE,
        dispatched: false,
        reason: 'permission_or_freshness_changed',
      };
    const completion = await this.dispatch(identity.requestId, callbacks, this.mode);
    let localSync: LocalSyncState = LOCAL_SYNC_STATE.COMPLETE;
    if (completion.status === ACTION_STATE.SUCCEEDED && callbacks.sync) {
      try {
        await callbacks.sync(completion.result);
      } catch {
        localSync = LOCAL_SYNC_STATE.PENDING;
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
      if (result.status === ACTION_STATE.SUCCEEDED && !result.evidence.requestTerminated)
        return { ...result, status: ACTION_STATE.UNKNOWN };
      if (
        result.status === ACTION_STATE.FAILED &&
        (result.evidence.kind !== ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT ||
          !result.evidence.requestTerminated)
      )
        return { ...result, status: ACTION_STATE.UNKNOWN };
      return result;
    } catch (error) {
      return {
        status: ACTION_STATE.UNKNOWN,
        evidence: {
          kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
          requestTerminated: false,
          // Preserve the response code for diagnosis without storing upstream text/PII.
          // A nonzero code alone is not a verified guarantee of zero external effects.
          detail:
            error instanceof ProviderBusinessError && Number.isSafeInteger(error.code)
              ? `provider_business_error:${error.code}`
              : 'external_call_did_not_return_terminal_evidence',
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
    if (record.mode !== ACTION_MODE.EXECUTE) return null;
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
    if (record.localSync === LOCAL_SYNC_STATE.COMPLETE) return this.existing<T>(record, dispatched);
    try {
      if (callbacks.sync) await callbacks.sync(record.result as T);
      await this.records.markSynced(record);
      return this.existing<T>({ ...record, localSync: LOCAL_SYNC_STATE.COMPLETE }, dispatched);
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

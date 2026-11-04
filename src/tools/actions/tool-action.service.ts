import { ActionOpsEventService } from '@biz/ops-events/services/action-ops-event.service';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import type {
  ActionCompletion,
  ActionExecution,
  ActionIntent,
  ActionSyncContext,
} from '@biz/action-execution/action-execution.types';
import { SpongeService } from '@sponge/sponge.service';
import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type InterviewBookingResult,
  type WorkOrderMutationResult,
} from '@sponge/sponge.types';
import { LongTermService } from '@memory/long-term/long-term.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { PhoneSessionIndexService } from '@memory/phone-session-index.service';
import { sessionFactValue } from '@memory/short-term/short-term.types';
import { CollectionFormStore } from '@tools/collection/collection-form.store';
import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { spongeActionCompletion, toolActionIntent } from './business-action.util';
import {
  ACTION_EVIDENCE_KIND,
  ACTION_KIND,
  ACTION_MODE,
  ACTION_STATE,
} from '@shared-types/action-execution.contract';
import type { SpongeActionKind } from '@shared-types/action-execution.contract';
import { PERMITTED_ACTION } from '@shared-types/action-permit.types';

const recoverySchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  botUserId: z.string(),
  botImId: z.string(),
  phone: z.string().nullable().optional(),
  jobId: z.number().optional(),
  workOrderId: z.number().optional(),
  candidateRef: z.string().optional(),
  formDigest: z.string().optional(),
  additional: z.boolean().optional(),
  testing: z.boolean().optional(),
  identity: z
    .object({ name: z.string(), phone: z.string(), age: z.string(), gender: z.string() })
    .optional(),
});

const KINDS = [
  ACTION_KIND.SPONGE_BOOKING,
  ACTION_KIND.SPONGE_CANCEL,
  ACTION_KIND.SPONGE_MODIFY,
  ACTION_KIND.MESSAGE_LOCATION,
  ACTION_KIND.MESSAGE_INTERVIEW_ADDRESS,
] as const;

@Injectable()
export class ToolActionService implements OnModuleInit {
  constructor(
    private readonly executor: ActionExecutorService,
    private readonly recoveryRegistry: ActionRecoveryRegistry,
    private readonly sponge: SpongeService,
    private readonly longTerm: LongTermService,
    private readonly session: SessionStateService,
    private readonly phoneIndex: PhoneSessionIndexService,
    private readonly forms: CollectionFormStore,
    private readonly snapshots: BookingSnapshotService,
    private readonly permits: ActionPermitService,
    private readonly actionOpsEvents: ActionOpsEventService,
  ) {}

  onModuleInit(): void {
    for (const kind of KINDS)
      this.recoveryRegistry.register(kind, {
        // Current state cannot establish whether a timed-out request may still execute later.
        reconcile: async (): Promise<ActionCompletion<unknown>> => ({
          status: ACTION_STATE.UNKNOWN,
          evidence: {
            kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
            requestTerminated: false,
            detail: 'manual_provider_request_verification_required',
          },
        }),
        sync: (record, context) => this.sync(record.intent, record.result, context),
      });
  }

  async executeSponge<T extends InterviewBookingResult | WorkOrderMutationResult>(
    context: ToolBuildContext,
    input: {
      kind: SpongeActionKind;
      target: string;
      parameters: Record<string, unknown>;
      recovery: Record<string, unknown>;
    },
    dispatch: () => Promise<T>,
  ): Promise<ActionExecution<T>> {
    const intent = toolActionIntent(context, input);
    return this.executor.execute(intent, {
      authorize: () => this.authorized(context),
      dispatch: async (_requestId, mode) => {
        try {
          const result = await dispatch();
          if (
            mode === ACTION_MODE.EXECUTE &&
            input.kind === ACTION_KIND.SPONGE_BOOKING &&
            result.success &&
            !('workOrderId' in result && result.workOrderId)
          ) {
            return {
              status: ACTION_STATE.UNKNOWN,
              result,
              evidence: {
                kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
                requestTerminated: true,
                detail: 'booking_accepted_without_work_order_identity',
              },
            };
          }
          return spongeActionCompletion(result, input.kind);
        } catch {
          return {
            status: ACTION_STATE.UNKNOWN,
            evidence: {
              kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
              requestTerminated: false,
              detail: 'provider_response_unavailable',
            },
          };
        }
      },
      sync: (result) => this.sync(intent, result),
    });
  }

  async executeMessage(
    context: ToolBuildContext,
    kind: typeof ACTION_KIND.MESSAGE_LOCATION | typeof ACTION_KIND.MESSAGE_INTERVIEW_ADDRESS,
    target: string,
    parameters: Record<string, unknown>,
    dispatch: (requestId?: string) => Promise<unknown>,
  ): Promise<ActionExecution<unknown>> {
    return this.executor.execute(toolActionIntent(context, { kind, target, parameters }), {
      authorize: () => this.authorized(context),
      dispatch: async (requestId, mode) => {
        try {
          const result = await dispatch(mode === ACTION_MODE.EXECUTE ? requestId : undefined);
          const value =
            result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
          if (value.errcode === 0 || value.code === 0 || value.success === true)
            return {
              status: ACTION_STATE.SUCCEEDED,
              result,
              evidence: {
                kind: ACTION_EVIDENCE_KIND.ACCEPTED,
                requestTerminated: true,
                externalId: requestId,
                detail: 'send_request_accepted_not_read_receipt',
              },
            };
          return {
            status: ACTION_STATE.UNKNOWN,
            evidence: { kind: ACTION_EVIDENCE_KIND.INDETERMINATE, requestTerminated: false },
          };
        } catch {
          return {
            status: ACTION_STATE.UNKNOWN,
            evidence: { kind: ACTION_EVIDENCE_KIND.INDETERMINATE, requestTerminated: false },
          };
        }
      },
    });
  }

  private async authorized(context: ToolBuildContext): Promise<boolean> {
    if (context.runtime.hasNewerUserInput && (await context.runtime.hasNewerUserInput()))
      return false;
    const permit = await this.permits.evaluate({
      chatId: context.session.chatId ?? context.session.sessionId,
      action: PERMITTED_ACTION.TOOL,
      botImId: context.session.botImId,
      groupId: context.session.groupId,
      candidateIds: [context.session.userId, context.session.imContactId],
    });
    return permit.allowed;
  }

  private async sync(
    intent: ActionIntent,
    rawResult: unknown,
    context?: ActionSyncContext,
  ): Promise<void> {
    if (!intent.kind.startsWith('sponge.')) return;
    const data = recoverySchema.parse(intent.recovery);
    const result = z
      .object({ success: z.boolean(), workOrderId: z.number().nullish() })
      .passthrough()
      .parse(rawResult);
    if (!result.success) return;
    const workOrderId = result.workOrderId ?? data.workOrderId;
    if (!workOrderId) throw new Error('Successful action has no recoverable work order ID');
    // Historical success is required even when a newer business version supersedes the projection.
    await this.actionOpsEvents.sync(intent, rawResult, context);
    if (intent.kind === ACTION_KIND.SPONGE_CANCEL && !data.additional) {
      // Terminal cancellation evidence establishes a tombstone even while the list projection lags.
      // Its original event version prevents an old booking repair from resurrecting this work order.
      const current = await this.longTerm.clearActiveBooking(
        intent.corpId,
        data.userId,
        workOrderId,
        {
          strict: true,
          occurredAt: intent.occurredAt,
          ...(context ? { assertOwned: context.assertOwned } : {}),
        },
      );
      if (current === false) return;
    }
    await context?.assertOwned();
    await this.sponge.invalidateWorkOrderCache(workOrderId, { strict: true });
    await context?.assertOwned();
    await this.snapshots.invalidate(
      {
        phone: data.phone,
        botImId: data.botImId,
        corpId: intent.corpId,
        userId: data.userId,
      },
      { strict: true },
    );
    // Read the current provider projection before applying historical success. Missing/failed reads
    // leave local_sync pending; they never prove cancellation or permit a repeated write request.
    const current = await this.sponge.fetchSignupWorkOrders(
      { workOrderId, onlyCurrentAccount: true },
      { botImId: data.botImId },
      { timeoutMs: 3000, allowDefaultToken: false },
    );
    const order = current.workOrders.find((item) => item.workOrderId === workOrderId);
    if (!order?.currentStatus)
      throw new Error('Current work order state unavailable for local repair');
    const active = ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(order.currentStatus);
    if (intent.kind === ACTION_KIND.SPONGE_CANCEL) {
      if (active)
        throw new Error('Cancellation projection has not converged; keep local sync pending');
      return;
    }
    await context?.assertOwned();
    if (!data.additional) {
      if (active && order.jobId != null) {
        const current = await this.longTerm.setActiveBooking(
          intent.corpId,
          data.userId,
          workOrderId,
          { job_id: order.jobId, interview_time: order.interviewTime ?? null },
          {
            strict: true,
            occurredAt: intent.occurredAt,
            ...(context ? { assertOwned: context.assertOwned } : {}),
          },
        );
        if (current === false) return; // Historical success cannot overwrite newer local business facts.
      } else if (!active)
        await this.longTerm.clearActiveBooking(intent.corpId, data.userId, workOrderId, {
          strict: true,
          occurredAt: intent.occurredAt,
          ...(context ? { assertOwned: context.assertOwned } : {}),
        });
    }
    if (
      intent.kind !== ACTION_KIND.SPONGE_BOOKING ||
      !active ||
      !data.formDigest ||
      !data.candidateRef ||
      !data.jobId
    )
      return;
    await context?.assertOwned();
    const currentForm = await this.forms.markSubmittedIfUnchanged(
      {
        corpId: intent.corpId,
        userId: data.userId,
        botUserId: data.botUserId,
        candidateRef: data.candidateRef,
        jobId: data.jobId,
      },
      data.formDigest,
      workOrderId,
    );
    if (!currentForm || data.additional || !data.identity) return;
    // A later form/person or later identity fact supersedes this historical booking.
    const primaryRef = await this.forms.readPrimaryCandidateRef({
      corpId: intent.corpId,
      userId: data.userId,
      botUserId: data.botUserId,
      jobId: data.jobId,
    });
    if (primaryRef !== data.candidateRef) return;
    const state = await this.session.getSessionState(intent.corpId, data.userId, data.sessionId);
    const identityFields = ['name', 'phone', 'age', 'gender'] as const;
    if (
      identityFields.some((field) => {
        const fact = state.facts?.interview_info?.[field];
        return (
          fact &&
          fact.value !== data.identity?.[field] &&
          Date.parse(fact.extractedAt) > Date.parse(intent.occurredAt)
        );
      })
    )
      return;
    const identity = data.identity;
    const fact = (value: string, field: string) =>
      sessionFactValue(value, {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: `收资表单办结：${field}`,
        extractedAt: intent.occurredAt,
      });
    await context?.assertOwned();
    await this.session.saveCompletedCollectionFacts(
      intent.corpId,
      data.userId,
      data.sessionId,
      {
        name: fact(identity.name, '姓名'),
        phone: fact(identity.phone, '手机号'),
        age: fact(identity.age, '年龄'),
        gender: sessionFactValue(identity.gender, {
          confidence: 'high',
          source: 'system',
          evidence: '收资表单办结：性别',
          extractedAt: intent.occurredAt,
        }),
      },
      ...(context ? ([{ requireExisting: true }] as const) : ([] as const)),
    );
    await context?.assertOwned();
    if (!data.testing)
      await this.phoneIndex.record(
        identity.phone,
        {
          corpId: intent.corpId,
          userId: data.userId,
          chatId: data.sessionId,
          botImId: data.botImId,
          botUserId: data.botUserId,
        },
        { strict: true },
      );
    await context?.assertOwned();
    await this.longTerm.writeFromBooking(
      intent.corpId,
      data.userId,
      data.botUserId,
      { ...identity, age: Number(identity.age), jobId: order.jobId ?? data.jobId, workOrderId },
      { sessionId: data.sessionId, botImId: data.botImId },
      { strict: true, occurredAt: intent.occurredAt },
    );
  }
}

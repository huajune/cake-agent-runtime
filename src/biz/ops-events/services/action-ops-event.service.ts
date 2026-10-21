import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ActionIntent, ActionSyncContext } from '@biz/action-execution/action-execution.types';
import { OpsEventsRecorderService } from './ops-events-recorder.service';
import type { RecordOpsEventInput } from '../types/ops-events.types';

const scopeSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  botUserId: z.string(),
  botImId: z.string(),
  workOrderId: z.number().optional(),
  jobId: z.number().optional(),
  opsEventPayload: z.record(z.string(), z.unknown()).optional(),
});
const resultSchema = z.object({ success: z.boolean(), workOrderId: z.number().nullish() });

/** Projects a confirmed historical fact; never queries or invokes an external action. */
@Injectable()
export class ActionOpsEventService {
  constructor(private readonly recorder: OpsEventsRecorderService) {}

  async sync(intent: ActionIntent, rawResult: unknown, context?: ActionSyncContext): Promise<void> {
    if (!['sponge.booking', 'sponge.cancel', 'sponge.modify'].includes(intent.kind)) return;
    const result = resultSchema.parse(rawResult);
    if (!result.success) return;
    const scope = scopeSchema.parse(intent.recovery);
    const workOrderId = result.workOrderId ?? scope.workOrderId;
    if (typeof workOrderId !== 'number' || !Number.isSafeInteger(workOrderId) || workOrderId <= 0)
      throw new Error('Confirmed action has no stable work order ID for its event');
    if (!Number.isFinite(Date.parse(intent.occurredAt)))
      throw new Error('Original event time missing');
    const payload: Record<string, unknown> = {
      ...scope.opsEventPayload,
      work_order_id: workOrderId,
      logical_turn_id: intent.logicalTurnId,
    };
    let eventName: RecordOpsEventInput['eventName'];
    let idempotencyKey: string;
    if (intent.kind === 'sponge.booking') {
      eventName = 'booking.succeeded';
      idempotencyKey = String(workOrderId);
      payload.job_id = intent.parameters.jobId ?? scope.jobId ?? payload.job_id ?? null;
      payload.interview_time = intent.parameters.interviewTime ?? payload.interview_time ?? null;
      // No invitation result can be inferred from booking success. A later
      // original tool continuation may fill this field through the narrow RPC.
      delete payload.group_invite;
    } else if (intent.kind === 'sponge.cancel') {
      eventName = 'booking.canceled';
      idempotencyKey = `${workOrderId}:canceled`;
      payload.cancel_reason_id =
        intent.parameters.cancelReasonId ?? payload.cancel_reason_id ?? null;
      payload.cancel_reason_desc =
        intent.parameters.cancelReasonDesc ?? payload.cancel_reason_desc ?? null;
    } else {
      const time = intent.parameters.newInterviewTime;
      if (typeof time !== 'string' || !time.trim())
        throw new Error('Original interview time missing');
      eventName = 'booking.interview_modified';
      idempotencyKey = `${workOrderId}:interview_modified:${time.trim()}`;
      payload.new_interview_time = time.trim();
    }
    await this.recorder.recordEventDurably(
      {
        corpId: intent.corpId,
        eventName,
        idempotencyKey,
        occurredAt: intent.occurredAt,
        botImId: scope.botImId,
        managerName: scope.botUserId,
        userId: scope.userId,
        chatId: scope.sessionId,
        payload,
      },
      context,
    );
  }
}

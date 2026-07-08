import { Injectable } from '@nestjs/common';
import { MessageDeliveryService } from '@wecom/message/delivery/delivery.service';
import type { DeliveryContext, DeliveryResult } from '@wecom/message/types';
import type { TurnOutcome } from '../runner/agent-runner.types';

export const REENGAGEMENT_DELIVERY_PORT = Symbol('REENGAGEMENT_DELIVERY_PORT');

export interface ReengagementDeliveryPort<TOutcome = unknown, TResult = unknown> {
  deliver(
    outcome: TOutcome,
    options?: { idempotencyKey?: string; context?: unknown },
  ): Promise<TResult>;
}

@Injectable()
export class ReengagementDeliveryService
  implements ReengagementDeliveryPort<TurnOutcome, DeliveryResult>
{
  constructor(private readonly delivery: MessageDeliveryService) {}

  async deliver(
    outcome: TurnOutcome,
    options?: { idempotencyKey?: string; context?: DeliveryContext },
  ): Promise<DeliveryResult> {
    const text = outcome.reply?.text?.trim();
    if (outcome.kind !== 'reply' || !text) {
      throw new Error(`reengagement_delivery_non_reply:${outcome.kind}`);
    }
    const context = options?.context;
    if (!context?.token || !context.imBotId || !context.imContactId) {
      throw new Error('reengagement_delivery_missing_context');
    }

    return this.delivery.deliverReply(
      { content: text, reasoning: outcome.reasoning },
      context,
      false,
    );
  }
}

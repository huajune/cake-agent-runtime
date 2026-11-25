import type { ActionMode } from '../action-execution/action-execution.types';
import type {
  ReplyProjectionStatus,
  ReplyReviewReason,
  ReplyTurnStatus,
  ReplyDeliveryPolicy,
  ReplyDeliveryOutcome,
} from './reply-execution.constants';

export interface ReplyTurnScope {
  corpId: string;
  accountId: string;
  chatId: string;
}

/** Delivery summary retained after the pending segments have been removed. */
export interface ReplyDeliverySummary {
  outcome: ReplyDeliveryOutcome;
  accepted?: number;
  total?: number;
}

export interface ReplyTurn extends ReplyTurnScope {
  /** Explicitly persisted; unsupported historical policies fail at the read boundary. */
  deliveryPolicy: ReplyDeliveryPolicy;
  deliveryResult?: ReplyDeliverySummary;

  logicalTurnId: string;
  inputIds: string[];
  inputOccurredAt: string;
  mode: ActionMode;
  status: ReplyTurnStatus;
  owner: string | null;
  fence: number;
  recovery: Record<string, unknown> & { replySegments?: string[] };
  projectionStatus?: ReplyProjectionStatus;
  reviewRequired?: boolean;
  reviewReason?: ReplyReviewReason;
  reviewNotifiedAt?: string;
}

/** Deliberate suspension, never a reason to generate/send a fallback. */
export class ReplyDeferredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(`reply_deferred:${reason}`);
    this.name = 'ReplyDeferredError';
  }
}

/** The sending worker has receipts for this prefix, while the remaining segments are pending. */
export class ReplyDeliveryDeferredError extends ReplyDeferredError {
  constructor(
    error: unknown,
    public readonly accepted: number,
  ) {
    super(error instanceof ReplyDeferredError ? error.reason : 'reply_delivery_pending', error);
  }
}

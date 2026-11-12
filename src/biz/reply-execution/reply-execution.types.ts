import type { ActionMode } from '../action-execution/action-execution.types';
import type {
  ReplyProjectionStatus,
  ReplyTurnStatus,
  ReplyDeliveryPolicy,
  ReplyDeliveryOutcome,
} from './reply-execution.constants';

export interface ReplyTurnScope {
  corpId: string;
  accountId: string;
  chatId: string;
}

/** Summary only: no generated reply body, model result or resumable send plan. */
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
  recovery: Record<string, unknown>;
  projectionStatus?: ReplyProjectionStatus;
}

/** Deliberate suspension, never a reason to generate/send a fallback. */
export class ReplyDeferredError extends Error {
  constructor(public readonly reason: string) {
    super(`reply_deferred:${reason}`);
    this.name = 'ReplyDeferredError';
  }
}

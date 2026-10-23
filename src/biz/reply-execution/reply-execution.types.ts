import type { ActionMode } from '../action-execution/action-execution.types';

export interface ReplyTurnScope {
  corpId: string;
  accountId: string;
  chatId: string;
}

export interface ReplySegment {
  index: number;
  text: string;
  actionId: string;
  requestId: string;
}

/** Only recovery data. Never put credentials or the entire conversation here. */
export interface ReplyPlan {
  version: 1;
  text: string;
  segments: ReplySegment[];
  resume?: Record<string, unknown>;
}

export interface ReplyTurn extends ReplyTurnScope {
  logicalTurnId: string;
  inputIds: string[];
  inputOccurredAt: string;
  mode: ActionMode;
  status: 'preparing' | 'planned' | 'settled' | 'acked';
  owner: string | null;
  fence: number;
  plan: ReplyPlan | null;
  recovery: Record<string, unknown>;
  projectionStatus?: 'none' | 'pending' | 'complete';
}

/** Deliberate suspension, never a reason to generate/send a fallback. */
export class ReplyDeferredError extends Error {
  constructor(public readonly reason: string) {
    super(`reply_deferred:${reason}`);
    this.name = 'ReplyDeferredError';
  }
}

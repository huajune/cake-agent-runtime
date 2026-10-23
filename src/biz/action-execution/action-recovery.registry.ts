import { Injectable } from '@nestjs/common';
import type { ActionRecoveryHandler } from './action-execution.types';

@Injectable()
export class ActionRecoveryRegistry {
  private readonly handlers = new Map<string, ActionRecoveryHandler>();
  register(kind: string, handler: ActionRecoveryHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Duplicate action recovery handler: ${kind}`);
    this.handlers.set(kind, handler);
  }
  get(kind: string): ActionRecoveryHandler | undefined {
    return this.handlers.get(kind);
  }
}

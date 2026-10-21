import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActionMode } from '../action-execution/action-execution.types';
import { actionDigest } from '../action-execution/action-identity';
import { ReplyTurnsRepository } from './reply-turns.repository';
import {
  ReplyDeferredError,
  type ReplyPlan,
  type ReplyTurn,
  type ReplyTurnScope,
} from './reply-execution.types';

const RETENTION_MS = 90 * 86400_000;

@Injectable()
export class ReplyTurnsService {
  private readonly logger = new Logger(ReplyTurnsService.name);
  readonly mode: ActionMode;
  private readonly cutover: number | null;
  constructor(
    readonly repository: ReplyTurnsRepository,
    config: ConfigService,
  ) {
    this.mode = config.get<ActionMode>('ACTION_EXECUTION_MODE', 'observe');
    const value = config.get<string>('ACTION_EXECUTION_CUTOVER_AT');
    this.cutover = value ? Date.parse(value) : null;
    if (
      !['off', 'observe', 'execute'].includes(this.mode) ||
      (this.cutover !== null && !Number.isFinite(this.cutover)) ||
      (this.mode === 'execute' && this.cutover === null)
    ) {
      throw new Error('Reply execution requires a valid mode and durable cutover boundary');
    }
  }

  async open(
    scope: ReplyTurnScope,
    inputIds: string[],
    inputOccurredAt: string,
    recovery: Record<string, unknown> = {},
  ): Promise<ReplyTurn | undefined> {
    const occurred = Date.parse(inputOccurredAt);
    if (
      this.mode === 'execute' &&
      (!Number.isFinite(occurred) ||
        occurred < this.cutover! ||
        occurred < Date.now() - RETENTION_MS ||
        occurred > Date.now() + 60000)
    ) {
      throw new ReplyDeferredError('input_outside_recovery_boundary');
    }
    if (!inputIds.length || inputIds.some((id) => !id?.trim()))
      throw new ReplyDeferredError('missing_input_membership');
    try {
      const turn = await this.repository.transition('open', {
        ...scope,
        inputIds: [...new Set(inputIds)],
        inputOccurredAt,
        recovery,
        logicalTurnId: randomUUID(),
        owner: randomUUID(),
        mode: this.mode,
      });
      if (!turn) return undefined;
      if (turn.mode !== 'execute') {
        if (this.mode === 'execute')
          throw new ReplyDeferredError('observation_turn_requires_cutover_review');
        this.logger.debug(`reply.observe ${turn.logicalTurnId}`);
        return undefined;
      }
      if (Date.parse(turn.inputOccurredAt) < Date.now() - RETENTION_MS)
        throw new ReplyDeferredError('recovery_expired');
      return turn;
    } catch (error) {
      if (error instanceof ReplyDeferredError) throw error;
      if (this.mode === 'execute' || this.cutover !== null)
        throw new ReplyDeferredError('membership_unconfirmed');
      this.logger.warn('reply.would_block membership_unconfirmed');
      return undefined;
    }
  }

  async savePlan(turn: ReplyTurn, plan: ReplyPlan): Promise<ReplyTurn> {
    try {
      actionDigest(plan);
    } catch {
      throw new ReplyDeferredError('invalid_reply_plan');
    }
    return this.update(turn, 'plan', { plan });
  }
  async settle(turn: ReplyTurn): Promise<ReplyTurn> {
    return this.update(turn, 'settle');
  }
  async acked(turn: ReplyTurn): Promise<ReplyTurn> {
    return this.update(turn, 'ack');
  }
  async defer(turn: ReplyTurn): Promise<void> {
    await this.update(turn, 'defer');
  }
  private async update(
    turn: ReplyTurn,
    operation: string,
    extra: Record<string, unknown> = {},
  ): Promise<ReplyTurn> {
    try {
      const next = await this.repository.transition(operation, { ...turn, ...extra });
      if (!next) throw new Error('turn_missing');
      return next;
    } catch {
      throw new ReplyDeferredError(`${operation}_not_confirmed`);
    }
  }
}

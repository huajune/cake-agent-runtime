import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActionMode } from '../action-execution/action-execution.types';
import { ReplyTurnsRepository } from './reply-turns.repository';
import {
  ReplyDeferredError,
  type ReplyTurn,
  type ReplyTurnScope,
  type ReplyDeliverySummary,
} from './reply-execution.types';
import {
  REPLY_TURN_OPERATION,
  REPLY_DELIVERY_POLICY,
} from '@biz/reply-execution/reply-execution.constants';
import { ACTION_MODE, isActionMode } from '@shared-types/action-execution.contract';
import type { ReplyTurnOperation } from './reply-execution.constants';

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
    this.mode = config.get<ActionMode>('ACTION_EXECUTION_MODE', ACTION_MODE.OBSERVE);
    const value = config.get<string>('ACTION_EXECUTION_CUTOVER_AT');
    this.cutover = value ? Date.parse(value) : null;
    if (
      !isActionMode(this.mode) ||
      (this.cutover !== null && !Number.isFinite(this.cutover)) ||
      (this.mode === ACTION_MODE.EXECUTE && this.cutover === null)
    ) {
      throw new Error('Reply execution requires a valid mode and durable cutover boundary');
    }
  }

  async open(
    scope: ReplyTurnScope,
    inputIds: string[],
    inputOccurredAt: string,
    recovery: Record<string, unknown>,
  ): Promise<ReplyTurn | undefined> {
    if (this.mode !== ACTION_MODE.EXECUTE && this.cutover === null) return undefined;
    const occurred = Date.parse(inputOccurredAt);
    if (
      this.mode === ACTION_MODE.EXECUTE &&
      (!Number.isFinite(occurred) ||
        occurred < this.cutover! ||
        occurred < Date.now() - RETENTION_MS ||
        occurred > Date.now() + 60000)
    ) {
      throw new ReplyDeferredError('input_outside_recovery_boundary');
    }
    if (!inputIds.length || inputIds.some((id) => !id?.trim()))
      throw new ReplyDeferredError('missing_input_membership');
    if (
      !recovery.primary ||
      typeof recovery.primary !== 'object' ||
      Array.isArray(recovery.primary) ||
      recovery.task !== undefined
    )
      throw new ReplyDeferredError('primary_reply_input_required');
    try {
      const turn = await this.repository.transition(REPLY_TURN_OPERATION.OPEN, {
        ...scope,
        inputIds: [...new Set(inputIds)],
        inputOccurredAt,
        recovery: this.inputContext(recovery),
        deliveryPolicy: REPLY_DELIVERY_POLICY.SINGLE_PASS,
        logicalTurnId: randomUUID(),
        owner: randomUUID(),
        mode: this.mode,
      });
      if (!turn) return undefined;
      if (turn.mode !== ACTION_MODE.EXECUTE) {
        if (this.mode === ACTION_MODE.EXECUTE)
          throw new ReplyDeferredError('observation_turn_requires_cutover_review');
        this.logger.debug(`reply.observe ${turn.logicalTurnId}`);
        return undefined;
      }
      if (Date.parse(turn.inputOccurredAt) < Date.now() - RETENTION_MS)
        throw new ReplyDeferredError('recovery_expired');
      return turn;
    } catch (error) {
      if (error instanceof ReplyDeferredError) throw error;
      if (this.mode === ACTION_MODE.EXECUTE || this.cutover !== null)
        throw new ReplyDeferredError('membership_unconfirmed');
      this.logger.warn('reply.would_block membership_unconfirmed');
      return undefined;
    }
  }

  async saveEffects(turn: ReplyTurn, effects: Record<string, unknown>): Promise<ReplyTurn> {
    return this.update(turn, REPLY_TURN_OPERATION.SAVE_EFFECTS, { effects });
  }
  async startDelivery(turn: ReplyTurn): Promise<ReplyTurn> {
    return this.update(turn, REPLY_TURN_OPERATION.START_DELIVERY);
  }
  async assertInputActive(turn: ReplyTurn): Promise<void> {
    await this.update(turn, REPLY_TURN_OPERATION.CHECK_INPUT);
  }
  async assertDeliveryActive(turn: ReplyTurn): Promise<void> {
    await this.update(turn, REPLY_TURN_OPERATION.CHECK_DELIVERY);
  }
  async interrupt(turn: ReplyTurn): Promise<ReplyTurn> {
    return this.update(turn, REPLY_TURN_OPERATION.INTERRUPT);
  }
  async settle(turn: ReplyTurn, deliveryResult?: ReplyDeliverySummary): Promise<ReplyTurn> {
    return this.update(turn, REPLY_TURN_OPERATION.SETTLE, { deliveryResult });
  }
  async acked(turn: ReplyTurn): Promise<ReplyTurn> {
    return this.update(turn, REPLY_TURN_OPERATION.ACK);
  }
  async defer(turn: ReplyTurn): Promise<void> {
    await this.update(turn, REPLY_TURN_OPERATION.DEFER);
  }
  async completeProjection(turn: ReplyTurn): Promise<void> {
    await this.update(turn, REPLY_TURN_OPERATION.PROJECT);
  }
  private inputContext(recovery: Record<string, unknown>): Record<string, unknown> {
    const primary = recovery.primary as Record<string, unknown>;
    // Only route identity is needed to authorize this live turn and acknowledge its input later.
    // No original text/model result is retained for background regeneration.
    const keys = ['orgId', 'imBotId', 'chatId', 'imContactId', 'imRoomId', 'groupId', '_apiType'];
    return {
      primary: Object.fromEntries(
        keys.filter((key) => primary[key] !== undefined).map((key) => [key, primary[key]]),
      ),
    };
  }

  private async update(
    turn: ReplyTurn,
    operation: ReplyTurnOperation,
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

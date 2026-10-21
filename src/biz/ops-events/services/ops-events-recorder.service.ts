import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { CRITICAL_WRITE_JOB_OPTIONS } from '@infra/queue/queue-policy';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { CRITICAL_OPS_EVENT_QUEUE } from '../critical-event.processor';
import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { BotGroupResolverService } from './bot-group-resolver.service';
import { OpsEventsRepository } from '../repositories/ops-events.repository';
import type {
  CandidateMessageResult,
  OpsEventWriteResult,
  RecordCandidateMessageInput,
  RecordOpsEventInput,
} from '../types/ops-events.types';

/**
 * 运营事件记录统一入口。
 *
 * 所有事件写入都走这里：内部调 PG RPC 完成「写 ops_events 底账（幂等）+ 投影 daily_ops_report」。
 *
 * 设计原则：
 * - 普通入口失败不阻断主流程；可靠补账入口需落库或恢复队列确认，否则抛错保留 pending。
 * - 失败只补记账，不触发外部动作重试。
 * - **幂等**：重复 idempotencyKey 由底账 UNIQUE 拒绝，投影不会重复 +1。
 * - occurredAt 缺省取当前时间；report_date 由 RPC 内部按 Asia/Shanghai 计算。
 */
@Injectable()
export class OpsEventsRecorderService {
  private readonly logger = new Logger(OpsEventsRecorderService.name);

  constructor(
    private readonly repository: OpsEventsRepository,
    private readonly botGroupResolver: BotGroupResolverService,
    @InjectQueue(CRITICAL_OPS_EVENT_QUEUE)
    private readonly recoveryQueue: Queue<RecordOpsEventInput>,
    private readonly failures: QueueFailureService,
  ) {}

  /**
   * 记录一个运营事件。
   * @returns 是否**首次**插入（false = 重复或失败）。
   *
   * 注意：仅凭 boolean 无法区分「重复」与「失败」。若调用方用返回值做语义判定
   * （如「首条插入=开场白」），失败会被误判成重复——请改用 {@link recordEventDetailed}。
   */
  async recordEvent(input: RecordOpsEventInput): Promise<boolean> {
    return (await this.recordEventDetailed(input)) === 'inserted';
  }

  /**
   * 记录一个运营事件，返回三态结果（inserted / duplicate / failed）。
   *
   * 供「依赖首次插入返回值做业务判定」的调用方使用：失败（failed）时不应被当作
   * 重复（duplicate），调用方可据此跳过本轮分类、等待后续重试，避免漏记。
   */
  async recordEventDetailed(input: RecordOpsEventInput): Promise<OpsEventWriteResult> {
    return this.persistEvent(input, false);
  }

  /** Action local_sync completes only after DB confirmation or durable recovery admission. */
  async recordEventDurably(
    input: RecordOpsEventInput,
    context?: { assertOwned(): Promise<void> },
  ): Promise<void> {
    if (!input.occurredAt) throw new Error('Durable event requires original occurrence time');
    await this.persistEvent(input, true, context);
  }

  /** Preserve opening classification when its event committed before follow-up scheduling failed. */
  async recordOpeningDurably(
    input: RecordOpsEventInput,
    logicalTurnId: string,
    context?: { assertOwned(): Promise<void> },
  ): Promise<boolean> {
    if (input.eventName !== 'agent.opening_sent' || !input.chatId || !input.occurredAt)
      throw new Error('Invalid durable opening identity');
    const result = await this.persistEvent(
      {
        ...input,
        payload: { ...input.payload, logical_turn_id: logicalTurnId },
      },
      true,
      context,
    );
    return (
      result === 'inserted' ||
      (await this.repository.openingLogicalTurn(input.corpId, input.chatId)) === logicalTurnId
    );
  }

  private async persistEvent(
    input: RecordOpsEventInput,
    requireDurable: boolean,
    context?: { assertOwned(): Promise<void> },
  ): Promise<OpsEventWriteResult> {
    let enriched = { ...input, occurredAt: input.occurredAt ?? new Date() };
    let result: OpsEventWriteResult = 'failed';
    await context?.assertOwned();
    try {
      enriched = this.enrichBotGroup(enriched);
      result = context
        ? await this.repository.upsertOpsEvent(enriched, context)
        : await this.repository.upsertOpsEvent(enriched);
    } catch (error) {
      this.logger.warn(`记录运营事件失败 event=${input.eventName}: ${this.errorMessage(error)}`);
    }
    if (result !== 'failed') return result;
    const critical = [
      'booking.succeeded',
      'booking.canceled',
      'booking.interview_modified',
      'interview.passed',
    ].includes(input.eventName);
    if (critical) {
      await context?.assertOwned();
      try {
        const invite = enriched.payload?.group_invite;
        const inviteVariant =
          input.eventName === 'booking.succeeded' &&
          invite &&
          typeof invite === 'object' &&
          !Array.isArray(invite)
            ? `:invite:${JSON.stringify(Object.entries(invite).sort(([a], [b]) => a.localeCompare(b)))}`
            : '';
        const jobId = createHash('sha256')
          .update(`${input.corpId}:${input.eventName}:${input.idempotencyKey}${inviteVariant}`)
          .digest('hex');
        await this.recoveryQueue.add('persist', enriched, { ...CRITICAL_WRITE_JOB_OPTIONS, jobId });
      } catch (error) {
        // Both sinks failed: expose the gap; never re-run the external booking to repair its accounting.
        await this.failures.report('ops.critical_event_not_durable', input.eventName, error);
        if (requireDurable) throw error;
      }
    } else if (requireDurable) {
      throw new Error(`Event persistence not confirmed: ${input.eventName}`);
    }
    return 'failed';
  }

  /**
   * 记录候选人消息（candidate.message_received）并原子检测首条破冰（candidate.engaged）。
   *
   * 调用方（accept-inbound）已排除微信「加好友纯默认招呼语」（「我是{昵称}」「请求添加你为朋友」
   * 「我通过了你的…验证请求」）——这些不算候选人真实开口、不进破冰；带求职意图的「我是找工作的」仍计入。
   */
  async recordCandidateMessage(
    input: RecordCandidateMessageInput,
  ): Promise<CandidateMessageResult> {
    try {
      const occurredAt = input.occurredAt ?? new Date();
      const enriched = this.enrichBotGroup(input);
      return await this.repository.checkAndRecordFirstEngaged({ ...enriched, occurredAt });
    } catch (error) {
      this.logger.warn(
        `记录候选人消息失败 chat=${input.chatId} msg=${input.messageId}: ${this.errorMessage(error)}`,
      );
      return { messageRecorded: false, engaged: false };
    }
  }

  /**
   * 从 botImId 反范式带出 manager_name / group_name。
   *
   * resolver 命中即为权威值（覆盖调用方传入），保证 group_name 是规范小组名，
   * Codex 读取侧才能按 group_name 做小组切片；未命中时回退调用方传入值。
   */
  private enrichBotGroup<
    T extends { botImId?: string | null; managerName?: string | null; groupName?: string | null },
  >(input: T): T {
    const resolved = this.botGroupResolver.resolve(input.botImId);
    if (!resolved) return input;
    return {
      ...input,
      managerName: resolved.managerName ?? input.managerName ?? null,
      groupName: resolved.groupName ?? input.groupName ?? null,
    };
  }

  private errorMessage(error: unknown): string {
    return toErrorMessage(error);
  }
}

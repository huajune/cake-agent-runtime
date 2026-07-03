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
 * - **绝不阻断主流程**：任何失败只 warn 日志、返回 false，不抛异常。
 * - **幂等**：重复 idempotencyKey 由底账 UNIQUE 拒绝，投影不会重复 +1。
 * - occurredAt 缺省取当前时间；report_date 由 RPC 内部按 Asia/Shanghai 计算。
 */
@Injectable()
export class OpsEventsRecorderService {
  private readonly logger = new Logger(OpsEventsRecorderService.name);

  constructor(
    private readonly repository: OpsEventsRepository,
    private readonly botGroupResolver: BotGroupResolverService,
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
    try {
      const occurredAt = input.occurredAt ?? new Date();
      const enriched = this.enrichBotGroup(input);
      return await this.repository.upsertOpsEvent({ ...enriched, occurredAt });
    } catch (error) {
      this.logger.warn(
        `记录运营事件失败 event=${input.eventName} key=${input.idempotencyKey}: ${this.errorMessage(error)}`,
      );
      return 'failed';
    }
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
    return error instanceof Error ? error.message : String(error);
  }
}

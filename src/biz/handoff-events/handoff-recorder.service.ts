import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { BotGroupResolverService } from '@biz/ops-events/services/bot-group-resolver.service';
import { HandoffEventsRepository } from './handoff-events.repository';
import type { HandoffWriteOutcome, RecordHandoffInput } from './handoff-events.types';

/**
 * 转人工记录统一入口。
 *
 * 一次 record 同时落两条：
 * 1. handoff_events 转人工工单，保存建议、处理进度与结果
 * 2. ops_events(handoff.triggered)（投影 daily_ops_report.handoff_count + cohort）
 *
 * 两者共用同一 idempotencyKey，保证重复触发不重复计数。绝不阻断主流程：失败只 warn。
 */
@Injectable()
export class HandoffRecorderService {
  private readonly logger = new Logger(HandoffRecorderService.name);

  constructor(
    private readonly repository: HandoffEventsRepository,
    private readonly botGroups: BotGroupResolverService,
  ) {}

  async record(input: RecordHandoffInput): Promise<HandoffWriteOutcome> {
    try {
      const outcome = await this.repository.recordHandoffTicket(
        { ...input, occurredAt: input.occurredAt ?? new Date() },
        this.botGroups.resolve(input.botImId),
      );
      if (outcome === 'failed') this.logger.warn(`转人工记录事务失败 chat=${input.chatId}`);
      return outcome;
    } catch (error) {
      this.logger.warn(`转人工记录事务失败 chat=${input.chatId}: ${toErrorMessage(error)}`);
      return 'failed';
    }
  }
}

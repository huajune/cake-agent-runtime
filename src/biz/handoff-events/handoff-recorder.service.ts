import { Injectable, Logger } from '@nestjs/common';
import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';
import { HandoffEventsRepository } from './handoff-events.repository';
import type { RecordHandoffInput } from './handoff-events.types';

/**
 * 转人工记录统一入口。
 *
 * 一次 record 同时落两条：
 * 1. handoff_events 底账（转人工原因/阶段分析的数据源，幂等）
 * 2. ops_events(handoff.triggered)（投影 daily_ops_report.handoff_count + cohort）
 *
 * 两者共用同一 idempotencyKey，保证重复触发不重复计数。绝不阻断主流程：失败只 warn。
 */
@Injectable()
export class HandoffRecorderService {
  private readonly logger = new Logger(HandoffRecorderService.name);

  constructor(
    private readonly repository: HandoffEventsRepository,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
  ) {}

  async record(input: RecordHandoffInput): Promise<void> {
    const occurredAt = input.occurredAt ?? new Date();

    try {
      await this.repository.insertHandoffEvent({ ...input, occurredAt });
    } catch (error) {
      this.logger.warn(
        `写入 handoff_events 失败 chat=${input.chatId} code=${input.reasonCode}: ${this.errorMessage(error)}`,
      );
    }

    // handoff.triggered 事件底账 + 日报投影（manager/group 由 OpsEventsRecorder 反范式带出）。
    await this.opsEventsRecorder.recordEvent({
      corpId: input.corpId,
      eventName: 'handoff.triggered',
      idempotencyKey: input.idempotencyKey,
      occurredAt,
      botImId: input.botImId,
      userId: input.userId,
      chatId: input.chatId,
      payload: {
        reason_code: input.reasonCode,
        reason: input.reason ?? null,
        stage: input.stage ?? null,
        work_order_id: input.workOrderId ?? null,
      },
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

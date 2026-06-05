import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SpongeService } from '@sponge/sponge.service';
import {
  addLocalDays,
  formatLocalDate,
  getLocalDayStart,
  parseLocalDateTime,
} from '@infra/utils/date.util';
import { OpsEventsRepository } from './ops-events.repository';
import { OpsEventsRecorderService } from './ops-events-recorder.service';

/**
 * 海绵工单状态轮询 cron（每 15 分钟）。
 *
 * 海绵的面试通过没有回调，只能主动轮询：对 window 内「已 booking.succeeded、尚未 interview.passed」
 * 的工单，实时查海绵状态并补记 interview.passed（幂等，键 = workOrderId:pass）。
 * 一旦 interview.passed，下个周期该工单即从待轮询集合移除。
 *
 * 注：统计收口到「面试通过」，不再采集入职（candidate.hired）。
 */
@Injectable()
export class SpongeStatusPollService {
  private readonly logger = new Logger(SpongeStatusPollService.name);
  private readonly lookbackDays = 60;
  private running = false;

  constructor(
    private readonly opsEventsRepository: OpsEventsRepository,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly spongeService: SpongeService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'Asia/Shanghai' })
  async poll(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮海绵状态轮询尚未结束，跳过本次');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('海绵状态轮询失败', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  /** 执行一次轮询（独立方法便于测试 / 手动触发）。 */
  async runOnce(): Promise<{ scanned: number; passed: number }> {
    const sinceReportDate = formatLocalDate(addLocalDays(getLocalDayStart(), -this.lookbackDays));
    const pending = await this.opsEventsRepository.findWorkOrdersPendingPass(sinceReportDate);

    let passed = 0;
    for (const wo of pending) {
      // 必须按工单所属托管账号（botImId）解析 Duliday-Token：多账号下各账号只能查到
      // 自己的工单，缺了 botImId 会退回 fallback token，查不到别家工单 → interview.passed 漏记。
      const workOrder = await this.spongeService
        .getCachedWorkOrderById(wo.workOrderId, { botImId: wo.botImId })
        .catch(() => null);
      if (!workOrder) continue;

      if (workOrder.interviewPassTime) {
        const inserted = await this.opsEventsRecorder.recordEvent({
          corpId: wo.corpId,
          eventName: 'interview.passed',
          idempotencyKey: `${wo.workOrderId}:pass`,
          occurredAt: this.parseTime(workOrder.interviewPassTime),
          botImId: wo.botImId,
          userId: wo.userId,
          chatId: wo.chatId,
          payload: {
            work_order_id: wo.workOrderId,
            current_status: workOrder.currentStatus ?? null,
          },
        });
        if (inserted) passed += 1;
      }
    }

    this.logger.log(`海绵状态轮询完成: 扫描=${pending.length}, 新通过=${passed}`);
    return { scanned: pending.length, passed };
  }

  /**
   * 海绵时间字符串（"YYYY-MM-DD HH:mm:ss"，中国本地时间、无时区）→ Date；非法时回退当前时间。
   *
   * 必须按 Asia/Shanghai 显式解析：UTC 容器里 `new Date('...T...')` 会当成 UTC，
   * 使傍晚的面试通过/上岗时间被 RPC 的 report_date 算到次日（见 parseLocalDateTime）。
   */
  private parseTime(value: string): Date {
    return parseLocalDateTime(value) ?? new Date();
  }
}

import { toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AlertLevel } from '@enums/alert.enum';
import { addLocalDays, formatLocalDate, getLocalDayStart } from '@infra/utils/date.util';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { OpsEventsRepository } from '../repositories/ops-events.repository';

/**
 * 「首次报名成功后同轮拉群率」周巡检（PRD R3 观测）。
 *
 * 口径：booking.succeeded 事件 payload.group_invite.outcome，
 * - 分子：invited + already_in_group；
 * - 分母：分子 + failed:*（剔除 failed:no_group_in_city / failed:no_group_available——
 *   城市本就没群不是链路失败）；skipped:*（群聊、代报、非首次、城市未知、已邀请）不进分母。
 * 与周报 SKILL 里的 SQL 同一口径；低于阈值发飞书告警。这个指标曾从 66% 跌到 25% 两个月
 * 无人发现，直到运营在群里反馈。
 * 只在生产运行（RUNTIME_ENV / NODE_ENV = production）：测试库样本会误触发低拉群率告警。
 */

/** 城市本就没群：不是链路失败，剔出分母。 */
const NON_ATTRIBUTABLE_FAILURES = new Set(['failed:no_group_in_city', 'failed:no_group_available']);

export interface PostBookingInviteRateSummary {
  sinceReportDate: string;
  untilReportDate: string;
  /** 窗口内带 group_invite 结果的 booking.succeeded 事件数。 */
  total: number;
  eligible: number;
  succeeded: number;
  /** eligible=0 时为 null。 */
  rate: number | null;
  failedByReason: Record<string, number>;
  skippedByReason: Record<string, number>;
}

export function summarizePostBookingInviteOutcomes(
  outcomes: ReadonlyArray<{ outcome: string | null }>,
  window: { sinceReportDate: string; untilReportDate: string },
): PostBookingInviteRateSummary {
  const summary: PostBookingInviteRateSummary = {
    ...window,
    total: 0,
    eligible: 0,
    succeeded: 0,
    rate: null,
    failedByReason: {},
    skippedByReason: {},
  };
  for (const { outcome } of outcomes) {
    if (!outcome) continue;
    summary.total += 1;
    if (outcome === 'invited' || outcome === 'already_in_group') {
      summary.eligible += 1;
      summary.succeeded += 1;
      continue;
    }
    if (outcome.startsWith('failed:')) {
      summary.failedByReason[outcome] = (summary.failedByReason[outcome] ?? 0) + 1;
      if (!NON_ATTRIBUTABLE_FAILURES.has(outcome)) summary.eligible += 1;
      continue;
    }
    if (outcome.startsWith('skipped:')) {
      summary.skippedByReason[outcome] = (summary.skippedByReason[outcome] ?? 0) + 1;
    }
  }
  summary.rate = summary.eligible > 0 ? summary.succeeded / summary.eligible : null;
  return summary;
}

@Injectable()
export class PostBookingInviteRateCronService {
  private readonly logger = new Logger(PostBookingInviteRateCronService.name);
  private readonly windowDays = 7;
  private readonly threshold: number;
  private readonly minSamples: number;
  private running = false;

  constructor(
    private readonly opsEventsRepository: OpsEventsRepository,
    private readonly alertNotifier: AlertNotifierService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.threshold = Number.parseFloat(
      this.configService?.get<string>('POST_BOOKING_INVITE_RATE_ALERT_THRESHOLD', '0.8') ?? '0.8',
    );
    this.minSamples = Number.parseInt(
      this.configService?.get<string>('POST_BOOKING_INVITE_RATE_MIN_SAMPLES', '20') ?? '20',
      10,
    );
  }

  /** 每周一 09:30 Asia/Shanghai，回看上周一至周日。 */
  @Cron('30 9 * * 1', { timeZone: 'Asia/Shanghai' })
  async run(): Promise<void> {
    if (this.isReadOnlyPreview()) return;
    if (!this.isProduction()) {
      this.logger.debug('报名后拉群率巡检只在生产运行，跳过');
      return;
    }
    if (this.running) {
      this.logger.warn('上一轮报名后拉群率巡检尚未结束，跳过本次');
      return;
    }
    this.running = true;
    try {
      const today = getLocalDayStart();
      await this.check({
        sinceReportDate: formatLocalDate(addLocalDays(today, -this.windowDays)),
        untilReportDate: formatLocalDate(addLocalDays(today, -1)),
      });
    } catch (error) {
      this.logger.error('报名后拉群率巡检失败', toErrorStack(error));
    } finally {
      this.running = false;
    }
  }

  /** 执行一次巡检（独立方法便于测试 / 手动触发）。 */
  async check(window: {
    sinceReportDate: string;
    untilReportDate: string;
  }): Promise<PostBookingInviteRateSummary> {
    const outcomes = await this.opsEventsRepository.findBookingGroupInviteOutcomes(
      window.sinceReportDate,
      window.untilReportDate,
    );
    const summary = summarizePostBookingInviteOutcomes(outcomes, window);
    this.logger.log(
      `报名后同轮拉群率 ${window.sinceReportDate}~${window.untilReportDate}: ` +
        `${summary.succeeded}/${summary.eligible}` +
        `${summary.rate === null ? '' : ` = ${(summary.rate * 100).toFixed(1)}%`}` +
        ` (total=${summary.total}, threshold=${this.threshold}, minSamples=${this.minSamples})`,
    );

    if (
      summary.rate !== null &&
      summary.eligible >= this.minSamples &&
      summary.rate < this.threshold
    ) {
      await this.alertNotifier.sendAlert({
        code: 'ops.post_booking_invite_rate_low',
        severity: AlertLevel.WARNING,
        summary:
          `首次报名后同轮拉群率 ${(summary.rate * 100).toFixed(1)}% 低于阈值 ` +
          `${(this.threshold * 100).toFixed(0)}%（${summary.succeeded}/${summary.eligible}，` +
          `${window.sinceReportDate}~${window.untilReportDate}）`,
        source: {
          subsystem: 'ops-events',
          component: 'post-booking-invite-rate',
          action: 'weekly_check',
          trigger: 'cron',
        },
        diagnostics: {
          category: 'post_booking_invite_rate_low',
          payload: {
            ...summary,
            threshold: this.threshold,
            minSamples: this.minSamples,
          },
        },
        dedupe: { key: `ops.post_booking_invite_rate_low:${window.untilReportDate}` },
      });
    }
    return summary;
  }

  private isReadOnlyPreview(): boolean {
    return this.configService?.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
  }

  private isProduction(): boolean {
    const runtimeEnv =
      this.configService?.get<string>('RUNTIME_ENV') ||
      this.configService?.get<string>('NODE_ENV') ||
      'development';
    return runtimeEnv === 'production';
  }
}

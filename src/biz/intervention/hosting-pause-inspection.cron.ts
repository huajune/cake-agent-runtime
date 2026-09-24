import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '@infra/redis/redis.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import { getHandoffReasonLabel } from '@enums/handoff-reason.enum';

/** 人工恢复类暂停超过该天数仍未恢复即提醒。 */
const OVERDUE_DAYS = 3;
/** 单轮最多提醒条数：超期集合是存量，分多轮消化，避免一次刷屏。 */
const MAX_ALERTS_PER_RUN = 30;
/** 整轮互斥锁 TTL（秒）：多副本只跑一份；单轮硬上限 MAX_RUN_MS 远小于它。 */
const LOCK_TTL_SECONDS = 10 * 60;
const MAX_RUN_MS = 60 * 1000;
/** 每会话只提醒一次：幂等键 TTL 30 天，暂停被恢复后再暂停的属新一轮，键随会话+暂停时刻区分。 */
const ALERTED_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOCK_KEY = 'intervention:pause_overdue:cron_lock';
const ALERTED_KEY_PREFIX = 'intervention:pause_overdue:alerted';
/** 只巡检人工介入产生的暂停；黑名单/真人接管等其它来源的永久暂停不归运营跟进。 */
const INSPECTED_PAUSE_SOURCE = 'intervention';

export interface PauseOverdueInspectionResult {
  scanned: number;
  overdue: number;
  alerted: number;
  skipped: number;
}

/**
 * 永久暂停超期巡检（PRD R5.2）：人工恢复类转人工（面试后跟进、在职事务）暂停到运营在
 * Dashboard 恢复为止；运营忘了恢复，候选人就永远收不到回复。每 2 小时扫一遍
 * user_hosting_status 里 source=intervention 的永久暂停，超过 3 天未恢复的按会话提醒一次。
 *
 * 只读 UserHostingService 的暂停缓存（已按 permanent/未过期过滤，体量小），不扫全表。
 * 只在生产运行（RUNTIME_ENV / NODE_ENV = production）：本地/测试环境连的是测试库，提醒会误发到运营飞书。
 */
@Injectable()
export class HostingPauseInspectionCron {
  private readonly logger = new Logger(HostingPauseInspectionCron.name);

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly redisService: RedisService,
    private readonly notifier: GeneralHandoffNotifierService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  @Cron('15 */2 * * *', { timeZone: 'Asia/Shanghai' })
  async inspect(): Promise<void> {
    if (this.isReadOnlyPreview()) return;
    if (!this.isProduction()) {
      this.logger.debug('永久暂停超期巡检只在生产运行，跳过');
      return;
    }
    const lockToken = await this.acquireLock();
    if (!lockToken) {
      this.logger.debug('跳过永久暂停超期巡检：其他副本正在执行');
      return;
    }
    try {
      const result = await this.runOnce();
      this.logger.log(
        `永久暂停超期巡检完成: scanned=${result.scanned}, overdue=${result.overdue}, alerted=${result.alerted}, skipped=${result.skipped}`,
      );
    } catch (error) {
      this.logger.error('永久暂停超期巡检失败', toErrorStack(error));
    } finally {
      await this.releaseLock(lockToken);
    }
  }

  /** 执行一次巡检（独立方法便于测试 / 手动触发）。 */
  async runOnce(now: number = Date.now()): Promise<PauseOverdueInspectionResult> {
    const startedAt = Date.now();
    const cutoff = now - OVERDUE_DAYS * 24 * 60 * 60 * 1000;
    const paused = await this.userHostingService.getPausedUsersWithProfiles();
    const overdue = paused.filter(
      (entry) =>
        entry.isPermanent &&
        entry.pauseSource === INSPECTED_PAUSE_SOURCE &&
        entry.pausedAt > 0 &&
        entry.pausedAt <= cutoff,
    );

    let alerted = 0;
    let skipped = 0;
    for (const entry of overdue) {
      if (alerted >= MAX_ALERTS_PER_RUN || Date.now() - startedAt > MAX_RUN_MS) {
        skipped += 1;
        continue;
      }
      const alertedKey = `${ALERTED_KEY_PREFIX}:${entry.userId}:${entry.pausedAt}`;
      const firstTime = await this.redisService
        .setNx(alertedKey, now, ALERTED_TTL_SECONDS)
        .catch((error: unknown) => {
          this.logger.warn(
            `永久暂停超期提醒幂等键写入失败，本轮跳过: chatId=${entry.userId}, error=${toErrorMessage(error)}`,
          );
          return false;
        });
      if (!firstTime) {
        skipped += 1;
        continue;
      }
      const reasonCode = extractReasonCode(entry.pauseReason);
      const sent = await this.notifier.notifyPauseOverdue({
        chatId: entry.userId,
        overdueDays: Math.floor((now - entry.pausedAt) / (24 * 60 * 60 * 1000)),
        pausedAtLabel: formatShanghai(entry.pausedAt),
        pauseReason: entry.pauseReason,
        reasonCode,
        reasonLabel: reasonCode ? getHandoffReasonLabel(reasonCode) : undefined,
        contactName: entry.odName,
        botUserName: entry.botUserId,
        botImId: entry.imBotId,
      });
      if (sent) {
        alerted += 1;
      } else {
        // 发送失败释放幂等键，下一轮重试
        await this.redisService.del(alertedKey).catch(() => 0);
        skipped += 1;
      }
    }

    return { scanned: paused.length, overdue: overdue.length, alerted, skipped };
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

  /** 抢锁失败（含 Redis 异常）一律跳过本轮：多副本各自"回退照跑"会把同一条超期提醒发多遍。 */
  private async acquireLock(): Promise<string | null> {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const acquired = await this.redisService.setNx(LOCK_KEY, token, LOCK_TTL_SECONDS);
      return acquired ? token : null;
    } catch (error) {
      this.logger.warn(`获取永久暂停巡检锁失败，本轮跳过: ${toErrorMessage(error)}`);
      return null;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redisService.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        [LOCK_KEY],
        [token],
      );
    } catch (error) {
      this.logger.warn('释放永久暂停巡检锁失败', error);
    }
  }
}

/** 暂停理由里可能带原因码（如「面试后人工对接，需人工恢复托管」不带；未来带 code= 时可解析）。 */
function extractReasonCode(pauseReason: string | undefined): string | undefined {
  const match = pauseReason?.match(/reason_code=([a-z_]+)/u);
  return match?.[1];
}

function formatShanghai(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

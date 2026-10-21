import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { QueueFailureService } from './queue-failure.service';
import { RedisLeaseService } from './redis-lease.service';

interface CronDefinition {
  id: string;
  intervalMs: number;
  /** UTC offset of the first scheduled occurrence in the interval. */
  offsetMs: number;
  weekdays?: readonly number[];
  productionOnly?: boolean;
}

const DAY = 86_400_000;
export const MANAGED_CRONS: readonly CronDefinition[] = [
  { id: 'ops-daily-report', intervalMs: DAY, offsetMs: 13 * 3_600_000 },
  { id: 'sponge-status-poll', intervalMs: 15 * 60_000, offsetMs: 0 },
  { id: 'chat-record-sync', intervalMs: DAY, offsetMs: 16 * 3_600_000 },
  { id: 'group-order-morning', intervalMs: DAY, offsetMs: 2 * 3_600_000, productionOnly: true },
  { id: 'group-order-afternoon', intervalMs: DAY, offsetMs: 5 * 3_600_000, productionOnly: true },
  { id: 'group-order-evening', intervalMs: DAY, offsetMs: 9.5 * 3_600_000, productionOnly: true },
  {
    id: 'group-part-time',
    intervalMs: DAY,
    offsetMs: 5.5 * 3_600_000,
    weekdays: [1, 2, 3, 4, 5],
    productionOnly: true,
  },
  {
    id: 'group-store-manager',
    intervalMs: DAY,
    offsetMs: 2.5 * 3_600_000,
    weekdays: [1, 2, 3, 4, 5],
    productionOnly: true,
  },
  {
    id: 'group-work-tips',
    intervalMs: DAY,
    offsetMs: 7 * 3_600_000,
    weekdays: [6],
    productionOnly: true,
  },
];

export interface CronBudget {
  /** Call before each next page / external write. Does not pretend to cancel an in-flight HTTP call. */
  checkpoint(rows?: number): Promise<void>;
}

@Injectable()
export class CronRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronRunnerService.name);

  constructor(
    private readonly leases: RedisLeaseService,
    private readonly redis: RedisService,
    private readonly failures: QueueFailureService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('READ_ONLY_PREVIEW', 'false') === 'true') return;
    for (const definition of MANAGED_CRONS) {
      if (definition.productionOnly && this.config.get<string>('NODE_ENV') !== 'production')
        continue;
      try {
        const now = Date.now();
        const key = `cron:last-observed:${definition.id}`;
        const previous = await this.redis.get<number>(key);
        let latest =
          Math.floor((now - definition.offsetMs) / definition.intervalMs) * definition.intervalMs +
          definition.offsetMs;
        if (definition.weekdays) {
          while (!definition.weekdays.includes(new Date(latest + 8 * 3_600_000).getUTCDay()))
            latest -= DAY;
        }
        // First installation establishes a baseline; only a persisted past baseline proves a missed round.
        if (previous !== null && latest > previous) {
          await this.failures.report(
            'cron.missed_schedule',
            definition.id,
            `错过定时轮次 ${new Date(latest).toISOString()}，仅告警，不自动补跑`,
          );
        }
        await this.redis.setex(key, 90 * 86400, now);
      } catch (error) {
        await this.failures.report('cron.schedule_check_failed', definition.id, error);
      }
    }
  }

  async run<T>(
    id: string,
    limits: { timeMs: number; maxRows: number },
    task: (budget: CronBudget) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.config.get<string>('READ_ONLY_PREVIEW', 'false') === 'true') return;
    if (
      !Number.isFinite(limits.timeMs) ||
      limits.timeMs <= 0 ||
      !Number.isSafeInteger(limits.maxRows) ||
      limits.maxRows <= 0
    ) {
      throw new Error('Cron budgets must be finite and positive');
    }
    const ttlSeconds = Math.ceil(limits.timeMs / 1000) + 60;
    const lease = await this.leases.acquire(`cron:lock:${id}`, ttlSeconds);
    if (!lease) return;
    const startedAt = Date.now();
    let rows = 0;
    const budget: CronBudget = {
      checkpoint: async (count = 0) => {
        rows += count;
        if (Date.now() - startedAt >= limits.timeMs || rows > limits.maxRows) {
          throw new Error(`Cron budget exhausted: rows=${rows}/${limits.maxRows}`);
        }
        if (!(await this.leases.renew(lease))) throw new Error('Cron lease lost');
      },
    };
    try {
      // Failure to establish the lifecycle record skips execution, just like failure to acquire a lease.
      await this.redis.setex(`cron:last-observed:${id}`, 90 * 86400, startedAt);
      await this.event(id, 'started', startedAt, rows);
      const result = await task(budget);
      await this.event(id, 'completed', startedAt, rows);
      return result;
    } catch (error) {
      await this.failures.report('cron.job_failed', id, error);
      await this.event(id, 'failed', startedAt, rows).catch(() => undefined);
      return undefined;
    } finally {
      // Await the task itself before releasing; a timeout race must never release a still-running writer.
      await this.leases.release(lease);
    }
  }

  private async event(id: string, status: string, startedAt: number, rows: number): Promise<void> {
    const event = { id, status, startedAt, updatedAt: Date.now(), rows };
    this.logger.log(JSON.stringify(event));
    await this.redis.setex(`cron:lifecycle:${id}`, 90 * 86400, event);
  }
}

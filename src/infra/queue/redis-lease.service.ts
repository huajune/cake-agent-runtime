import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { sleep } from '@infra/utils/async.util';
import { QueueFailureService } from './queue-failure.service';

export interface RedisLease {
  key: string;
  owner: string;
  ttlSeconds: number;
}

const RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";
const RENEW =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0";

/** Ownership checks are atomic. A lost lease never authorizes another external dispatch. */
@Injectable()
export class RedisLeaseService {
  constructor(
    private readonly redis: RedisService,
    private readonly failures: QueueFailureService,
  ) {}

  async acquire(
    key: string,
    ttlSeconds: number,
    options: { owner?: string; waitMs?: number; pollMs?: number } = {},
  ): Promise<RedisLease | null> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('Invalid lease TTL');
    const waitMs = options.waitMs ?? 0;
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60_000) {
      throw new Error('Lease wait must be bounded to 0–60000 ms');
    }
    const lease = { key, owner: options.owner ?? randomUUID(), ttlSeconds };
    const deadline = Date.now() + waitMs;
    try {
      do {
        if (await this.redis.setNx(key, lease.owner, ttlSeconds)) return lease;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await sleep(Math.min(Math.max(options.pollMs ?? 1000, 10), remaining));
      } while (Date.now() < deadline);
    } catch (error) {
      await this.failures.report('queue.lease_unavailable', key, error);
    }
    return null;
  }

  async renew(lease: RedisLease): Promise<boolean> {
    try {
      const renewed =
        (await this.redis.eval(RENEW, [lease.key], [lease.owner, lease.ttlSeconds])) === 1;
      if (!renewed)
        await this.failures.report(
          'queue.lease_lost',
          lease.key,
          'Lease expired or ownership changed',
        );
      return renewed;
    } catch (error) {
      await this.failures.report('queue.lease_unavailable', lease.key, error);
      return false;
    }
  }

  async release(lease: RedisLease): Promise<boolean> {
    try {
      return (await this.redis.eval(RELEASE, [lease.key], [lease.owner])) === 1;
    } catch (error) {
      await this.failures.report('queue.lease_release_failed', lease.key, error);
      return false;
    }
  }
}

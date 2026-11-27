import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { RedisKeyBuilder } from '../channels/wecom/message/runtime/redis-key.util';
import { RedisService } from '../infra/redis/redis.service';

/** Let the old worker finish inputs that predate the first confirmed ownership interval. */
export async function waitForPrebindingMessages(
  cutoff = Date.now(),
  redis: Pick<RedisService, 'scan' | 'lrange'> = new RedisService(new ConfigService()),
) {
  const deadline = Date.now() + 120_000;
  do {
    try {
      if (!(await hasEarlierMessages(redis, cutoff, deadline))) return;
    } catch {
      throw new Error('无法核对旧服务的待回复消息，请检查队列后重试切换');
    }
    await sleep(1000);
  } while (Date.now() < deadline);
  throw new Error('旧服务仍有登记前的待回复消息，请待其处理完毕后重试切换');
}

async function hasEarlierMessages(
  redis: Pick<RedisService, 'scan' | 'lrange'>,
  cutoff: number,
  deadline: number,
) {
  let cursor: string | number = 0;
  do {
    const page = await redis.scan(cursor, {
      match: RedisKeyBuilder.pattern('pending'),
      count: 200,
    });
    cursor = page[0];
    for (const key of page[1]) {
      // Read one atomic chat snapshot. ACKs can change list offsets while the old worker runs.
      const messages = await redis.lrange<unknown>(key, 0, -1);
      for (const item of messages) {
        const msg = typeof item === 'string' ? JSON.parse(item) : item;
        const at = Number(msg?.timestamp);
        if (!Number.isFinite(at) || at <= cutoff) return true;
      }
      if (Date.now() >= deadline) return true;
    }
    if (Date.now() >= deadline) return true;
  } while (String(cursor) !== '0');
  return false;
}

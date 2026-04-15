import { Injectable } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { RedisKeyBuilder } from '../runtime/redis-key.util';

@Injectable()
export class MessageTraceStoreService {
  private readonly TRACE_TTL_SECONDS = 24 * 60 * 60;

  constructor(private readonly redisService: RedisService) {}

  async get<T>(messageId: string): Promise<T | undefined> {
    const raw = await this.redisService.get<string | T>(RedisKeyBuilder.trace(messageId));

    if (!raw) {
      return undefined;
    }

    if (typeof raw === 'string') {
      return JSON.parse(raw) as T;
    }

    return raw as T;
  }

  async set<T>(messageId: string, trace: T): Promise<void> {
    await this.redisService.setex(
      RedisKeyBuilder.trace(messageId),
      this.TRACE_TTL_SECONDS,
      JSON.stringify(trace),
    );
  }

  async delete(messageId: string): Promise<void> {
    await this.redisService.del(RedisKeyBuilder.trace(messageId));
  }
}

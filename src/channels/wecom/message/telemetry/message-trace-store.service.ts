import { Injectable } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { RedisKeyBuilder } from '../runtime/redis-key.util';

type TraceRecord = Record<string, unknown>;

/**
 * 消息 Trace 的 Redis Hash 存储：
 * - request / agentRequest / agentResult 等大对象各自占一个 field；
 * - timings 的每个时间点独占一个 `timing:*` field；
 * - 更新阶段只传输发生变化的 field，避免整份 Trace 反复 GET + SET。
 *
 * key 沿用 `RedisKeyBuilder.trace(messageId) + ':v2'`，这是在途 Trace 跨发版的唯一契约，不可改名。
 */
@Injectable()
export class MessageTraceStoreService {
  private readonly TRACE_TTL_SECONDS = 24 * 60 * 60;
  private readonly KEY_SUFFIX = ':v2';
  private readonly SCHEMA_FIELD = '_traceSchema';
  private readonly SCHEMA_VERSION = 2;
  private readonly TIMING_PREFIX = 'timing:';

  constructor(private readonly redisService: RedisService) {}

  async get<T extends object>(messageId: string): Promise<T | undefined> {
    const hash = await this.redisService.hgetall<TraceRecord>(this.key(messageId));
    if (!this.isTrace(hash)) return undefined;
    return this.inflate<T>(hash);
  }

  async getFields<T extends object, K extends Extract<keyof T, string>>(
    messageId: string,
    fields: K[],
  ): Promise<Pick<T, K> | undefined> {
    const hash = await this.redisService.hmget<TraceRecord>(
      this.key(messageId),
      this.SCHEMA_FIELD,
      ...fields,
    );
    if (!this.isTrace(hash)) return undefined;
    return this.pickPresent<T, K>(hash, fields);
  }

  async getTimings<T extends object, K extends Extract<keyof T, string>>(
    messageId: string,
    fields: K[],
  ): Promise<Pick<T, K> | undefined> {
    const hash = await this.redisService.hmget<TraceRecord>(
      this.key(messageId),
      this.SCHEMA_FIELD,
      ...fields.map((field) => this.timingField(field)),
    );
    if (!this.isTrace(hash)) return undefined;
    return this.pickTimings<T, K>(hash, fields);
  }

  async exists(messageId: string): Promise<boolean> {
    return (await this.redisService.exists(this.key(messageId))) > 0;
  }

  async set<T extends object>(messageId: string, trace: T): Promise<void> {
    await this.writeHash(messageId, {
      ...this.flatten(trace as TraceRecord),
      [this.SCHEMA_FIELD]: this.SCHEMA_VERSION,
    });
  }

  async patch<T extends object>(messageId: string, patch: Partial<T>): Promise<void> {
    const fields = this.flatten(patch as TraceRecord);
    if (Object.keys(fields).length === 0) return;
    await this.writeHash(messageId, fields);
  }

  async patchTimings<T extends object>(messageId: string, timings: Partial<T>): Promise<void> {
    const fields: TraceRecord = {};
    for (const [field, value] of Object.entries(timings)) {
      if (value !== undefined) fields[this.timingField(field)] = value;
    }
    if (Object.keys(fields).length === 0) return;
    await this.writeHash(messageId, fields);
  }

  /**
   * 原子写单个时间点；onlyIfAbsent 用于只记录第一次发生时间。
   * 返回 true 表示本次确实写入；Trace 不存在或 NX 字段已存在时返回 false。
   */
  async setTiming(
    messageId: string,
    field: string,
    value: number,
    onlyIfAbsent = false,
  ): Promise<boolean> {
    const result = await this.redisService.eval(
      `
        if redis.call('hexists', KEYS[1], ARGV[5]) == 0 then return -1 end
        local changed
        if ARGV[4] == '1' then
          changed = redis.call('hsetnx', KEYS[1], ARGV[1], ARGV[2])
        else
          redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
          changed = 1
        end
        redis.call('expire', KEYS[1], ARGV[3])
        return changed
      `,
      [this.key(messageId)],
      [
        this.timingField(field),
        value,
        this.TRACE_TTL_SECONDS,
        onlyIfAbsent ? '1' : '0',
        this.SCHEMA_FIELD,
      ],
    );
    return Number(result) === 1;
  }

  async delete(messageId: string): Promise<void> {
    await this.redisService.del(this.key(messageId));
  }

  private async writeHash(messageId: string, fields: TraceRecord): Promise<void> {
    await this.redisService.hset(this.key(messageId), fields);
    await this.redisService.expire(this.key(messageId), this.TRACE_TTL_SECONDS);
  }

  private isTrace(hash: TraceRecord | null | undefined): hash is TraceRecord {
    return Number(hash?.[this.SCHEMA_FIELD]) === this.SCHEMA_VERSION;
  }

  private flatten(trace: TraceRecord): TraceRecord {
    const fields: TraceRecord = {};
    for (const [field, value] of Object.entries(trace)) {
      if (value === undefined) continue;
      if (field === 'timings' && value && typeof value === 'object') {
        for (const [timing, timestamp] of Object.entries(value as TraceRecord)) {
          if (timestamp !== undefined) fields[this.timingField(timing)] = timestamp;
        }
      } else {
        fields[field] = value;
      }
    }
    return fields;
  }

  private inflate<T extends object>(hash: TraceRecord): T {
    const trace: TraceRecord = {};
    const timings: TraceRecord = {};
    for (const [field, value] of Object.entries(hash)) {
      if (field === this.SCHEMA_FIELD) continue;
      if (field.startsWith(this.TIMING_PREFIX)) {
        timings[field.slice(this.TIMING_PREFIX.length)] = value;
      } else {
        trace[field] = value;
      }
    }
    if (Object.keys(timings).length > 0) trace.timings = timings;
    return trace as T;
  }

  private pickPresent<T extends object, K extends Extract<keyof T, string>>(
    source: TraceRecord,
    fields: K[],
  ): Pick<T, K> {
    const result: TraceRecord = {};
    for (const field of fields) {
      if (source[field] !== null && source[field] !== undefined) result[field] = source[field];
    }
    return result as Pick<T, K>;
  }

  private pickTimings<T extends object, K extends Extract<keyof T, string>>(
    source: TraceRecord,
    fields: K[],
  ): Pick<T, K> {
    const result: TraceRecord = {};
    for (const field of fields) {
      const value = source[this.timingField(field)];
      if (value !== null && value !== undefined) result[field] = Number(value);
    }
    return result as Pick<T, K>;
  }

  private key(messageId: string): string {
    return `${RedisKeyBuilder.trace(messageId)}${this.KEY_SUFFIX}`;
  }

  private timingField(field: string): string {
    return `${this.TIMING_PREFIX}${field}`;
  }
}

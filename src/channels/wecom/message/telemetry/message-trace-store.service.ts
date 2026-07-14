import { Injectable } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { RedisKeyBuilder } from '../runtime/redis-key.util';

type TraceRecord = Record<string, unknown>;

/**
 * Trace V2 使用 Redis Hash：
 * - request / agentRequest / agentResult 等大对象各自占一个 field；
 * - timings 的每个时间点独占一个 field；
 * - 更新阶段只传输发生变化的 field，避免整份 Trace 反复 GET + SET。
 *
 * V1 JSON key 保留只读兼容，滚动发布期间仍能完成旧的在途 Trace。
 */
@Injectable()
export class MessageTraceStoreService {
  private readonly TRACE_TTL_SECONDS = 24 * 60 * 60;
  private readonly V2_SUFFIX = ':v2';
  private readonly SCHEMA_FIELD = '_traceSchema';
  private readonly SCHEMA_VERSION = 2;
  private readonly TIMING_PREFIX = 'timing:';

  constructor(private readonly redisService: RedisService) {}

  async get<T extends object>(messageId: string): Promise<T | undefined> {
    const hash = await this.redisService.hgetall<TraceRecord>(this.v2Key(messageId));
    if (Number(hash?.[this.SCHEMA_FIELD]) === this.SCHEMA_VERSION) {
      return this.inflate<T>(hash);
    }

    const legacy = await this.getLegacy<T>(messageId);
    if (!hash) return legacy;

    // 兼容滚动发布：旧 Trace 在新版本中首次被 patch 时会出现一个不完整 V2 Hash。
    // 完整读取时以 V2 字段覆盖 V1，保证在途请求能够正常收尾。
    const current = this.inflate<T>(hash) as TraceRecord;
    const legacyRecord = (legacy ?? {}) as TraceRecord;
    return {
      ...legacyRecord,
      ...current,
      timings: {
        ...((legacyRecord.timings as TraceRecord | undefined) ?? {}),
        ...((current.timings as TraceRecord | undefined) ?? {}),
      },
    } as T;
  }

  async getFields<T extends object, K extends Extract<keyof T, string>>(
    messageId: string,
    fields: K[],
  ): Promise<Pick<T, K> | undefined> {
    const requested = [this.SCHEMA_FIELD, ...fields];
    const hash = await this.redisService.hmget<TraceRecord>(this.v2Key(messageId), ...requested);
    const complete = Number(hash?.[this.SCHEMA_FIELD]) === this.SCHEMA_VERSION;

    if (complete) return this.pickPresent<T, K>(hash ?? {}, fields);

    const legacy = await this.getLegacy<T>(messageId);
    if (!legacy && !hash) return undefined;

    return {
      ...this.pickPresent<T, K>((legacy ?? {}) as TraceRecord, fields),
      ...this.pickPresent<T, K>(hash ?? {}, fields),
    } as Pick<T, K>;
  }

  async getTimings<T extends object, K extends Extract<keyof T, string>>(
    messageId: string,
    fields: K[],
  ): Promise<Pick<T, K> | undefined> {
    const redisFields = fields.map((field) => this.timingField(field));
    const hash = await this.redisService.hmget<TraceRecord>(
      this.v2Key(messageId),
      this.SCHEMA_FIELD,
      ...redisFields,
    );
    const complete = Number(hash?.[this.SCHEMA_FIELD]) === this.SCHEMA_VERSION;
    const current = this.pickTimings<T, K>(hash ?? {}, fields);

    if (complete) return current;

    const legacy = await this.getLegacy<{ timings?: T }>(messageId);
    if (!legacy && !hash) return undefined;
    return { ...(legacy?.timings ?? {}), ...current } as Pick<T, K>;
  }

  async exists(messageId: string): Promise<boolean> {
    if ((await this.redisService.exists(this.v2Key(messageId))) > 0) return true;
    return (await this.redisService.exists(this.legacyKey(messageId))) > 0;
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

  /** 原子写单个时间点；onlyIfAbsent 用于只记录第一次发生时间。 */
  async setTiming(
    messageId: string,
    field: string,
    value: number,
    onlyIfAbsent = false,
  ): Promise<-1 | 0 | 1> {
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
      [this.v2Key(messageId)],
      [
        this.timingField(field),
        value,
        this.TRACE_TTL_SECONDS,
        onlyIfAbsent ? '1' : '0',
        this.SCHEMA_FIELD,
      ],
    );

    // -1 = V2 不存在（可能是滚动发布前创建的 V1 Trace），0 = NX 未写，1 = 已写。
    const status = Number(result);
    return status === 1 ? 1 : status === 0 ? 0 : -1;
  }

  async delete(messageId: string): Promise<void> {
    await this.redisService.del(this.v2Key(messageId), this.legacyKey(messageId));
  }

  private async writeHash(messageId: string, fields: TraceRecord): Promise<void> {
    await this.redisService.hset(this.v2Key(messageId), fields);
    await this.redisService.expire(this.v2Key(messageId), this.TRACE_TTL_SECONDS);
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

  private async getLegacy<T extends object>(messageId: string): Promise<T | undefined> {
    const raw = await this.redisService.get<string | T>(this.legacyKey(messageId));
    if (!raw) return undefined;
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : raw;
  }

  private legacyKey(messageId: string): string {
    return RedisKeyBuilder.trace(messageId);
  }

  private v2Key(messageId: string): string {
    return `${this.legacyKey(messageId)}${this.V2_SUFFIX}`;
  }

  private timingField(field: string): string {
    return `${this.TIMING_PREFIX}${field}`;
  }
}

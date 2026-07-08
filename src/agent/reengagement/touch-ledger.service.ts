import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import type { ReserveResult, TouchSlotState } from './reengagement.types';

export interface UnknownTouchSlot {
  key: string;
  state: 'unknown';
}

/**
 * 触达底账（频控 + outbox 幂等状态机）。
 *
 * 状态机：reserved → delivery_attempted → sent | failed | unknown。
 * - `reserve()` 用 Redis SET NX 原子占位；命中 `sent` → duplicate_sent（真已发，跳过）；
 *   命中其它（reserved/attempted）→ duplicate_inflight（上次未确认，可恢复）。
 * - 频控 24h ≤ 2 **只数 sent**（reserved/failed/unknown 不计——否则投递失败重投会被误算成多次触达）。
 * - 一旦进入 delivery_attempted，就处于"外部平台可能已发出"区间，不得盲目重投，
 *   必须靠 ReengagementDeliveryPort 的渠道侧幂等或补偿（见 agent-reengagement-design.md §4）。
 */
@Injectable()
export class TouchLedgerService {
  private readonly logger = new Logger(TouchLedgerService.name);

  /** 触达槽 TTL：覆盖单次复聊生命周期，远小于频控窗口。 */
  private readonly SLOT_TTL_S = 3 * 24 * 60 * 60;
  /** 频控窗口。 */
  private readonly FREQ_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** 同会话触达冷却窗口：避免不同场景在候选人感知上重复追问。 */
  readonly SESSION_TOUCH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
  /** 频控上限。 */
  readonly MAX_TOUCHES_PER_24H = 2;

  constructor(private readonly redis: RedisService) {}

  private slotKey(key: string): string {
    return `reengagement:touch:${key}`;
  }

  private sentListKey(sessionId: string): string {
    return `reengagement:sent:${sessionId}`;
  }

  private lastTouchKey(sessionId: string): string {
    return `reengagement:lastTouch:${sessionId}`;
  }

  /** 原子占位。已存在则按当前状态区分 duplicate_sent / duplicate_inflight。 */
  async reserve(key: string): Promise<ReserveResult> {
    const ok = await this.redis.setNx(this.slotKey(key), 'reserved', this.SLOT_TTL_S);
    if (ok) return 'reserved';
    const state = await this.getState(key);
    return state === 'sent' ? 'duplicate_sent' : 'duplicate_inflight';
  }

  async getState(key: string): Promise<TouchSlotState | null> {
    return (await this.redis.get<TouchSlotState>(this.slotKey(key))) ?? null;
  }

  async markDeliveryAttempted(key: string): Promise<void> {
    await this.redis.setex(this.slotKey(key), this.SLOT_TTL_S, 'delivery_attempted');
  }

  async markSent(key: string, sessionId: string, now: number): Promise<void> {
    // 频控与 session 冷却只数 confirmed sent，避免 shadow/失败投递压制后续真发。
    await this.redis.eval(
      `
redis.call('SETEX', KEYS[1], ARGV[1], 'sent')
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('SETEX', KEYS[3], ARGV[4], ARGV[2])
return 1
`,
      [this.slotKey(key), this.sentListKey(sessionId), this.lastTouchKey(sessionId)],
      [
        this.SLOT_TTL_S,
        now,
        Math.ceil(this.FREQ_WINDOW_MS / 1000) * 2,
        Math.ceil(this.SESSION_TOUCH_COOLDOWN_MS / 1000) * 2,
      ],
    );
  }

  /** markSent 落库失败等"状态不明" → unknown（不可盲重投，交补偿/告警）。 */
  async markFailedOrUnknown(key: string, state: 'failed' | 'unknown'): Promise<void> {
    await this.redis.setex(this.slotKey(key), this.SLOT_TTL_S, state);
    if (state === 'unknown') {
      this.logger.error(`[TouchLedger] 触达状态不明，置 unknown 待补偿: key=${key}`);
    }
  }

  /** 近 24h 已 **sent** 的触达次数（频控用）。 */
  async countSentIn24h(sessionId: string, now: number): Promise<number> {
    const raw = await this.redis.lrange<number | string>(this.sentListKey(sessionId), 0, -1);
    const cutoff = now - this.FREQ_WINDOW_MS;
    return raw.map((v) => Number(v)).filter((ts) => Number.isFinite(ts) && ts >= cutoff).length;
  }

  /** 频控是否已达上限。 */
  async isOverFrequencyLimit(sessionId: string, now: number): Promise<boolean> {
    const count = await this.countSentIn24h(sessionId, now);
    return count >= this.MAX_TOUCHES_PER_24H;
  }

  /** 最近一次同会话确认送达触达的时间戳。 */
  async getLastTouchAt(sessionId: string): Promise<number | null> {
    const raw = await this.redis.get<number | string>(this.lastTouchKey(sessionId));
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** 兼容入口；在线链路应通过 markSent 同一事务提交。 */
  async markLastTouch(sessionId: string, now: number): Promise<void> {
    await this.redis.setex(
      this.lastTouchKey(sessionId),
      Math.ceil(this.SESSION_TOUCH_COOLDOWN_MS / 1000) * 2,
      now,
    );
  }

  async isInSessionTouchCooldown(sessionId: string, now: number): Promise<boolean> {
    const lastTouchAt = await this.getLastTouchAt(sessionId);
    return lastTouchAt != null && now - lastTouchAt < this.SESSION_TOUCH_COOLDOWN_MS;
  }

  /**
   * 补偿查询入口：扫描状态不明的触达槽，供运维/人工核对外部平台投递状态。
   *
   * 返回的 key 是业务幂等键（`${sessionId}:${scenarioCode}:${anchorAt}`），不含 Redis 前缀。
   */
  async listUnknownSlots(limit = 100): Promise<UnknownTouchSlot[]> {
    const result: UnknownTouchSlot[] = [];
    let cursor: string | number = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, {
        match: 'reengagement:touch:*',
        count: Math.min(Math.max(limit, 10), 500),
      });
      cursor = next;
      for (const redisKey of keys) {
        const state = await this.redis.get<TouchSlotState>(redisKey);
        if (state !== 'unknown') continue;
        result.push({
          key: redisKey.replace(/^reengagement:touch:/, ''),
          state,
        });
        if (result.length >= limit) return result;
      }
    } while (String(cursor) !== '0');
    return result;
  }
}

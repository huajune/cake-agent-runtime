import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { SpongeService } from '@sponge/sponge.service';
import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  OPEN_RESULT_WORK_ORDER_STATUSES,
  type SignupWorkOrdersResult,
} from '@sponge/sponge.types';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import type {
  BookingSnapshotCacheRecord,
  BookingSnapshotEntry,
  BookingSnapshotLoadResult,
} from './booking-snapshot.types';
import {
  BOOKING_SNAPSHOT_CACHE_TTL_SECONDS,
  BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS,
  isSnapshotEligibleWorkOrder,
  toBookingSnapshotEntry,
} from './booking-snapshot.util';

/** 同一托管账号连续失败/超时达到该次数即开断。 */
export const BOOKING_SNAPSHOT_CIRCUIT_FAILURE_THRESHOLD = 3;
/** 开断后直接返回 failed（走指针回落）的时长。 */
export const BOOKING_SNAPSHOT_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
export const BOOKING_SNAPSHOT_CIRCUIT_OPEN_ERROR = 'circuit_open';

interface CircuitState {
  /** 连续失败次数；成功即清零。 */
  consecutiveFailures: number;
  /** 开断截止时间戳；到期后放一次试探（半开），再失败立即重新开断。 */
  openUntil: number;
}

export interface BookingSnapshotLoadInput {
  /** 候选人本人手机号（会话事实/长期档案）；代报同行人的手机号不参与。 */
  phone: string | null | undefined;
  /** 本会话托管账号；缺失或没配 token 一律跳过，禁止回退默认 token。 */
  botImId: string | null | undefined;
  /** 候选人身份（缓存镜像键，供出站守卫按身份读同一份快照）。 */
  corpId: string;
  userId: string;
  /** 本人校验的已知姓名（会话事实 / 长期档案）。 */
  knownCandidateNames: ReadonlyArray<string | null | undefined>;
  /** true 时穿透 5 分钟缓存（本轮命中面试类关键词）。 */
  bypassCache?: boolean;
  now?: number;
}

/**
 * 每轮预约快照：按候选人手机号用本会话托管账号 token 查一次海绵 signup/list，
 * 结果本地过滤为「状态在途 且（报名近 15 天 或 面试在未来）」，直接作为本轮的预约读视图。
 *
 * 查到就用、不落库：不写 active_booking、不建指针表。蛋糕侧只留 5 分钟 Redis 缓存
 * （按手机号+账号；另按候选人身份镜像一份，出站守卫读同一份）。
 *
 * 护栏：超时 3s；账号没配 token 直接跳过并落观测（默认 token 会查到别家账号的工单）；
 * 查询失败抛错→上层回落 active_booking 指针路径，不当成"没有工单"。
 * 熔断：同一账号连续 3 次失败/超时后 5 分钟内直接返回 failed，不再打海绵——海绵抖动时每轮
 * 都等满 3 秒超时会把回合时延整体抬高。计数在进程内（多实例各自独立开断，不共享）。
 */
@Injectable()
export class BookingSnapshotService {
  private readonly logger = new Logger(BookingSnapshotService.name);
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly spongeService: SpongeService,
    private readonly redisService: RedisService,
    private readonly hostingMemberConfig: HostingMemberConfigService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  async load(input: BookingSnapshotLoadInput): Promise<BookingSnapshotLoadResult> {
    const phone = input.phone?.trim() ?? '';
    if (!isStorableCandidatePhone(phone)) {
      this.emit({ type: 'booking_snapshot', status: 'skipped_no_phone' });
      return { status: 'skipped_no_phone' };
    }
    const botImId = input.botImId?.trim() ?? '';
    const token = botImId ? await this.hostingMemberConfig.resolveDulidayToken(botImId) : null;
    if (!token) {
      this.logger.warn(
        `预约快照跳过：托管账号未配置海绵 token（botImId=${botImId || '-'}），不回退默认 token`,
      );
      this.emit({ type: 'booking_snapshot', status: 'skipped_no_token', botImId });
      return { status: 'skipped_no_token' };
    }

    const now = input.now ?? Date.now();
    const cacheKey = snapshotCacheKey(botImId, phone);
    if (!input.bypassCache) {
      const cached = await this.readCache(cacheKey);
      if (cached) {
        this.emit({
          type: 'booking_snapshot',
          status: 'cache_hit',
          botImId,
          entryCount: cached.entries.length,
          supplierCount: countSupplier(cached.entries),
        });
        return { status: 'ok', ...cached, fromCache: true };
      }
    }

    if (this.isCircuitOpen(botImId, now)) {
      this.emit({ type: 'booking_snapshot', status: 'failed', botImId, circuitOpen: true });
      return { status: 'failed', error: BOOKING_SNAPSHOT_CIRCUIT_OPEN_ERROR, circuitOpen: true };
    }

    const startedAt = Date.now();
    let result: SignupWorkOrdersResult;
    try {
      result = await this.spongeService.fetchSignupWorkOrders(
        {
          phone,
          queryParam: { currentStatus: Array.from(ACTIVE_INTERVIEW_WORK_ORDER_STATUSES) },
        },
        { botImId },
        { timeoutMs: BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS, allowDefaultToken: false },
      );
    } catch (error) {
      const message = toErrorMessage(error);
      const opened = this.recordFailure(botImId, now);
      this.logger.warn(
        `预约快照查询失败（回落 active_booking 指针路径）phoneTail=${phone.slice(-4)} botImId=${botImId}: ${message}${opened ? `；连续失败达 ${BOOKING_SNAPSHOT_CIRCUIT_FAILURE_THRESHOLD} 次，${BOOKING_SNAPSHOT_CIRCUIT_OPEN_MS / 60000} 分钟内不再查海绵` : ''}`,
      );
      this.emit({
        type: 'booking_snapshot',
        status: 'failed',
        botImId,
        durationMs: Date.now() - startedAt,
        error: message,
        ...(opened ? { circuitOpen: true } : {}),
      });
      return { status: 'failed', error: message, ...(opened ? { circuitOpen: true } : {}) };
    }
    this.circuits.delete(botImId);

    const topCandidateName =
      typeof result.candidateName === 'string' && result.candidateName.trim()
        ? result.candidateName.trim()
        : null;
    const entries = (result.workOrders ?? [])
      .filter((order) => isSnapshotEligibleWorkOrder(order, now))
      .map((order) =>
        toBookingSnapshotEntry(order, {
          topCandidateName,
          knownNames: input.knownCandidateNames,
        }),
      );
    const record: BookingSnapshotCacheRecord = {
      entries,
      candidateName: topCandidateName,
      fetchedAt: now,
    };
    await this.writeCache(cacheKey, candidateCacheKey(input.corpId, input.userId), record);
    this.emit({
      type: 'booking_snapshot',
      status: 'ok',
      botImId,
      durationMs: Date.now() - startedAt,
      entryCount: entries.length,
      supplierCount: countSupplier(entries),
    });
    return { status: 'ok', ...record, fromCache: false };
  }

  /**
   * 按候选人身份读最近一次快照镜像（出站守卫/转人工卡片用，不触发海绵查询）。
   * 没有镜像返回 null——调用方按"未知"处理，不得当成"没有工单"。
   */
  async peekForCandidate(
    corpId: string,
    userId: string,
  ): Promise<BookingSnapshotCacheRecord | null> {
    return this.readCache(candidateCacheKey(corpId, userId));
  }

  /**
   * 清 booked 终态前的复核：按手机号**不带状态过滤**再查一次海绵，回答候选人名下是否还有任何
   * 在途/待结果工单（约面待确认 / 约面成功 / 面试成功）。快照本身只装「近 15 天或面试在未来」的
   * 在途单，AI 自建的老单（报名超 15 天且面试已过）会从快照消失但报名关系仍在，不能据此清终态。
   *
   * 查不到（无 token / 海绵失败 / 熔断中）返回 null——调用方按「未知」处理，不得当成「没有工单」。
   * 不读不写缓存；失败计入同账号熔断。
   */
  async hasOpenWorkOrders(input: {
    phone: string | null | undefined;
    botImId: string | null | undefined;
    now?: number;
  }): Promise<boolean | null> {
    const phone = input.phone?.trim() ?? '';
    if (!isStorableCandidatePhone(phone)) return null;
    const botImId = input.botImId?.trim() ?? '';
    const token = botImId ? await this.hostingMemberConfig.resolveDulidayToken(botImId) : null;
    if (!token) return null;
    const now = input.now ?? Date.now();
    if (this.isCircuitOpen(botImId, now)) return null;
    try {
      const result = await this.spongeService.fetchSignupWorkOrders(
        { phone },
        { botImId },
        { timeoutMs: BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS, allowDefaultToken: false },
      );
      this.circuits.delete(botImId);
      return (result.workOrders ?? []).some((order) =>
        OPEN_RESULT_WORK_ORDER_STATUSES.has(order.currentStatus?.trim() ?? ''),
      );
    } catch (error) {
      this.recordFailure(botImId, now);
      this.logger.warn(
        `在途工单复核查询失败（按未知处理）phoneTail=${phone.slice(-4)} botImId=${botImId}: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /** 取消、改约、报名成功后失效该手机号的快照（否则 5 分钟内仍显示在途）。 */
  async invalidate(input: {
    phone: string | null | undefined;
    botImId: string | null | undefined;
    corpId?: string;
    userId?: string;
  }): Promise<void> {
    const keys: string[] = [];
    const phone = input.phone?.trim() ?? '';
    const botImId = input.botImId?.trim() ?? '';
    if (phone && botImId) keys.push(snapshotCacheKey(botImId, phone));
    if (input.corpId && input.userId) keys.push(candidateCacheKey(input.corpId, input.userId));
    if (keys.length === 0) return;
    try {
      await this.redisService.del(...keys);
    } catch (error) {
      this.logger.warn(`预约快照缓存失效失败: ${toErrorMessage(error)}`);
    }
  }

  /** 开断中：同账号 5 分钟内不再打海绵。到期后放行一次试探，失败则由 recordFailure 重新开断。 */
  private isCircuitOpen(botImId: string, now: number): boolean {
    const state = this.circuits.get(botImId);
    return state !== undefined && state.openUntil > now;
  }

  /** 累计连续失败；达到阈值则开断并返回 true（本次即开断那一次，或半开试探再失败）。 */
  private recordFailure(botImId: string, now: number): boolean {
    const state = this.circuits.get(botImId) ?? { consecutiveFailures: 0, openUntil: 0 };
    state.consecutiveFailures += 1;
    const opened = state.consecutiveFailures >= BOOKING_SNAPSHOT_CIRCUIT_FAILURE_THRESHOLD;
    if (opened) state.openUntil = now + BOOKING_SNAPSHOT_CIRCUIT_OPEN_MS;
    this.circuits.set(botImId, state);
    return opened;
  }

  private async readCache(key: string): Promise<BookingSnapshotCacheRecord | null> {
    try {
      const cached = await this.redisService.get<BookingSnapshotCacheRecord>(key);
      return isCacheRecord(cached) ? cached : null;
    } catch (error) {
      this.logger.warn(`预约快照缓存读取失败 key=${key}: ${toErrorMessage(error)}`);
      return null;
    }
  }

  private async writeCache(
    phoneKey: string,
    identityKey: string,
    record: BookingSnapshotCacheRecord,
  ): Promise<void> {
    try {
      await Promise.all([
        this.redisService.setex(phoneKey, BOOKING_SNAPSHOT_CACHE_TTL_SECONDS, record),
        this.redisService.setex(identityKey, BOOKING_SNAPSHOT_CACHE_TTL_SECONDS, record),
      ]);
    } catch (error) {
      this.logger.warn(`预约快照缓存写入失败: ${toErrorMessage(error)}`);
    }
  }

  private emit(event: Parameters<AgentTracerService['emit']>[0]): void {
    this.tracer?.emit(event);
  }
}

function snapshotCacheKey(botImId: string, phone: string): string {
  return `booking:snapshot:${botImId}:${phone}`;
}

function candidateCacheKey(corpId: string, userId: string): string {
  return `booking:snapshot:candidate:${corpId}:${userId}`;
}

function countSupplier(entries: readonly BookingSnapshotEntry[]): number {
  return entries.filter((entry) => entry.signupSource === 'SUPPLIER').length;
}

function isCacheRecord(value: unknown): value is BookingSnapshotCacheRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.entries) && typeof record.fetchedAt === 'number';
}

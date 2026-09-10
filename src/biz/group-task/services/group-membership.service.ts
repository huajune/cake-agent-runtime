import { toErrorMessage } from '@infra/utils/error.util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GROUP_ROOM_QUERY, type GroupRoomQuery } from '../providers/group-channel.provider';
import { RedisService } from '@infra/redis/redis.service';

/**
 * 企业级群聊列表 API 返回的成员项
 */
interface EnterpriseRoomMember {
  imContactId: string;
  type?: number;
}

/**
 * 企业级群聊列表 API 返回的群项
 */
interface EnterpriseRoomItem {
  imRoomId?: string;
  wxid?: string;
  memberList?: EnterpriseRoomMember[];
}

/** 候选人在白名单群内的实际归属；`verified=false` 表示本次没能核验（缓存故障/预热超时），rooms 必为空。 */
export interface UserRoomsLookup {
  rooms: string[];
  verified: boolean;
  /** 未核验原因（hydrate_timeout / redis_error …），仅供观测与日志。 */
  reason?: string;
}

/** 群成员缓存预热超过等待上限：预热继续在后台进行，本次调用按「未核验」处理。 */
export class GroupMembershipHydrateTimeoutError extends Error {
  constructor(waitMs: number) {
    super(`群成员缓存预热超过 ${waitMs}ms 未完成`);
    this.name = 'GroupMembershipHydrateTimeoutError';
  }
}

/**
 * 群成员关系服务
 *
 * 职责：判断候选人是否已经在目标企微群内，避免重复拉人。
 *
 * 设计要点：
 * - 数据源为企业级群聊列表 API（`/api/v2/groupChat/list`），返回每个群的完整 memberList
 * - 只缓存"相关群"（由调用方提供 imRoomId 白名单，通常是 `resolveGroups('兼职群')` 的结果）
 *   企业级共 ~250 群 / 15000 成员，过滤后仅需缓存 ~10 群 / ~100 成员，避免无关数据占用 Redis
 * - Redis Set 结构：key = `room:members:{imRoomId}`，value = 成员 imContactId 集合
 * - TTL 10 分钟，与 `GroupResolverService` 的群列表缓存对齐
 * - 并发请求通过 in-flight Promise 防止缓存击穿
 * - 预热是全量分页拉企业群列表，生产 p90 曾超过 100 秒；调用方只等 `GROUP_MEMBERSHIP_HYDRATE_WAIT_MS`
 *   （默认 10s），超时按「未核验」降级，预热本身继续在后台跑完供后续回合复用
 */
@Injectable()
export class GroupMembershipService {
  private readonly logger = new Logger(GroupMembershipService.name);

  private static readonly CACHE_KEY_PREFIX = 'room:members';
  private static readonly CACHE_TTL_SECONDS = 10 * 60;
  private static readonly DEFAULT_HYDRATE_WAIT_MS = 10_000;

  private readonly enterpriseToken: string | null;
  /** 单次调用等待预热的上限（ms）；0 或负数表示不等待，直接按未核验处理。 */
  private readonly hydrateWaitMs: number;

  /** 防止并发 hydrate 重复请求 API */
  private hydratePromise: Promise<void> | null = null;
  /** 最近一次 hydrate 完成时间，用于快速判断是否已预热 */
  private lastHydratedAt = 0;

  constructor(
    private readonly redisService: RedisService,
    @Inject(GROUP_ROOM_QUERY) private readonly roomService: GroupRoomQuery,
    configService: ConfigService,
  ) {
    this.enterpriseToken = configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || null;
    const configuredWait = Number(configService.get<string>('GROUP_MEMBERSHIP_HYDRATE_WAIT_MS'));
    this.hydrateWaitMs = Number.isFinite(configuredWait)
      ? configuredWait
      : GroupMembershipService.DEFAULT_HYDRATE_WAIT_MS;
  }

  /**
   * 判断用户是否已经在指定群中
   *
   * 流程：
   * 1. 查询 Redis Set 是否存在目标群缓存，存在则直接 `sismember`
   * 2. 缓存缺失 → 从企业级 API 拉取群列表，按 `relevantRoomIds` 白名单过滤后预热
   * 3. 再次查询本地 Set
   *
   * @param imRoomId 待检查的群 ID
   * @param userImContactId 候选人 imContactId
   * @param relevantRoomIds 需要预热的群 ID 白名单（一般是本次调用上下文里所有候选兼职群）
   *                        不在白名单内的群会被丢弃，避免缓存无关数据
   *
   * 任何一步失败都返回 false（宁可重复调用拉人 API，也不要因为缓存问题漏拉）
   */
  async isUserInRoom(
    imRoomId: string,
    userImContactId: string,
    relevantRoomIds: Iterable<string>,
  ): Promise<boolean> {
    if (!imRoomId || !userImContactId) return false;

    const whitelist = new Set(relevantRoomIds);
    // 目标群必须在白名单内，否则不会被缓存，直接放行（返回 false 代表"未知即不拦截"）
    if (!whitelist.has(imRoomId)) return false;

    const key = this.buildKey(imRoomId);
    try {
      const exists = await this.redisService.exists(key);
      if (exists === 0) {
        await this.hydrateCache(whitelist, imRoomId);
      }

      const isMember = await this.redisService.sismember(key, userImContactId);
      return isMember === 1;
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.error(
        `检查群成员关系失败 (room=${imRoomId}, user=${userImContactId}): ${message}`,
      );
      return false;
    }
  }

  /**
   * 反查候选人当前实际在哪些群（relevantRoomIds 范围内），失败时返回空数组。
   *
   * 拉群链路用：宁可重复调用拉人 API，也不要因为缓存问题漏拉，所以未核验等同「不在群」。
   * 需要区分「核验过不在群」与「没核验成」的调用方（回合装配）走 {@link lookupUserRooms}。
   */
  async listUserRooms(
    userImContactId: string,
    relevantRoomIds: Iterable<string>,
  ): Promise<string[]> {
    return (await this.lookupUserRooms(userImContactId, relevantRoomIds)).rooms;
  }

  /**
   * 反查候选人当前实际在哪些群，并说明本次是否真的核验过。
   *
   * 供回合开始时注入"实时群状态"：拉群记忆只存会话层（TTL 2 天），过期后
   * Agent 不知道候选人已在群、可能重复邀请；且候选人可能自行退群，记忆会反向
   * 过期。实时成员关系（10 分钟缓存）是唯一可靠事实源。
   *
   * 缓存故障或预热超时不抛错：返回 `verified=false` + 原因，由调用方按「未知」降级并留观测痕迹，
   * 否则空结果会被当成「已核验：不在任何群」。
   */
  async lookupUserRooms(
    userImContactId: string,
    relevantRoomIds: Iterable<string>,
  ): Promise<UserRoomsLookup> {
    if (!userImContactId) return { rooms: [], verified: true };
    const whitelist = new Set(relevantRoomIds);
    if (whitelist.size === 0) return { rooms: [], verified: true };

    try {
      // 任一目标群缓存缺失 → 预热（一次 API 调用填充全部白名单群）。
      // Upstash 是 REST 往返，逐群串行 exists 曾让本步在回合装配里占中位 8 秒；并行探测只付一次往返。
      const presence = await Promise.all(
        Array.from(whitelist, async (roomId) => ({
          roomId,
          exists: (await this.redisService.exists(this.buildKey(roomId))) !== 0,
        })),
      );
      const missing = presence.find((entry) => !entry.exists);
      if (missing) {
        await this.hydrateCache(whitelist, missing.roomId);
      }

      const checks = await Promise.all(
        Array.from(whitelist, async (roomId) => ({
          roomId,
          isMember:
            (await this.redisService.sismember(this.buildKey(roomId), userImContactId)) === 1,
        })),
      );
      return { rooms: checks.filter((c) => c.isMember).map((c) => c.roomId), verified: true };
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      const reason =
        error instanceof GroupMembershipHydrateTimeoutError ? 'hydrate_timeout' : 'redis_error';
      this.logger.warn(`反查候选人群状态失败 (user=${userImContactId}, ${reason}): ${message}`);
      return { rooms: [], verified: false, reason };
    }
  }

  /**
   * 手动标记用户已进入群（用于拉人成功后即时更新缓存）
   */
  async markUserInRoom(imRoomId: string, userImContactId: string): Promise<void> {
    if (!imRoomId || !userImContactId) return;

    const key = this.buildKey(imRoomId);
    try {
      await this.redisService.sadd(key, userImContactId);
      await this.redisService.expire(key, GroupMembershipService.CACHE_TTL_SECONDS);
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.warn(
        `写入群成员缓存失败 (room=${imRoomId}, user=${userImContactId}): ${message}`,
      );
    }
  }

  /**
   * 主动清理某个群的成员缓存，用于拉群后强制重新校验成员关系。
   */
  async invalidateRoomCache(imRoomId: string): Promise<void> {
    if (!imRoomId) return;
    const key = this.buildKey(imRoomId);
    try {
      await this.redisService.del(key);
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.warn(`清理群成员缓存失败 (room=${imRoomId}): ${message}`);
    }
  }

  /**
   * 预热企业级群成员缓存：一次 API 调用填充白名单内所有群的 Set
   */
  private async hydrateCache(relevantRoomIds: Set<string>, missingRoomId?: string): Promise<void> {
    if (!this.enterpriseToken) {
      this.logger.warn('STRIDE_ENTERPRISE_TOKEN 未配置，跳过群成员缓存预热');
      return;
    }

    if (this.hydratePromise) return this.hydratePromise;

    // 最近刚 hydrate 过时，仅在目标 key 仍存在的情况下跳过，避免 Redis 提前过期造成误判。
    if (Date.now() - this.lastHydratedAt < GroupMembershipService.CACHE_TTL_SECONDS * 1000) {
      if (!missingRoomId) return;

      const targetExists = await this.redisService.exists(this.buildKey(missingRoomId));
      if (targetExists !== 0) return;
    }

    if (!this.hydratePromise) {
      this.hydratePromise = this.doHydrate(relevantRoomIds).finally(() => {
        this.hydratePromise = null;
      });
      // 等待方可能先超时离场；共享 Promise 的拒绝必须有人接住，否则成为 unhandledRejection。
      this.hydratePromise.catch(() => undefined);
    }
    return this.awaitHydrateBounded(this.hydratePromise);
  }

  /**
   * 只等待预热到 hydrateWaitMs：超时抛 {@link GroupMembershipHydrateTimeoutError}，预热本身不中断，
   * 后续调用继续复用同一个 in-flight Promise / 已落 Redis 的结果。
   */
  private async awaitHydrateBounded(hydrate: Promise<void>): Promise<void> {
    if (this.hydrateWaitMs <= 0) {
      throw new GroupMembershipHydrateTimeoutError(this.hydrateWaitMs);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GroupMembershipHydrateTimeoutError(this.hydrateWaitMs)),
        this.hydrateWaitMs,
      );
    });
    try {
      await Promise.race([hydrate, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async doHydrate(relevantRoomIds: Set<string>): Promise<void> {
    if (!this.enterpriseToken) return;
    if (relevantRoomIds.size === 0) return;

    const pageSize = 1000;
    let current = 1;
    let hasMore = true;
    let totalRooms = 0;
    let totalMembers = 0;

    while (hasMore) {
      const result = await this.roomService.getEnterpriseGroupChatList(
        this.enterpriseToken,
        current,
        pageSize,
      );

      const rooms: EnterpriseRoomItem[] = result?.data || [];
      if (!Array.isArray(rooms) || rooms.length === 0) break;

      for (const room of rooms) {
        const roomId = room.imRoomId || room.wxid;
        if (!roomId) continue;
        // 白名单过滤：只缓存本次调用关心的群（通常是兼职群）
        if (!relevantRoomIds.has(roomId)) continue;

        const members = (room.memberList || []).map((m) => m.imContactId).filter(Boolean);
        const key = this.buildKey(roomId);
        try {
          // 覆盖式写入：先删旧 Set，再 sadd，再 expire
          await this.redisService.del(key);
          if (members.length > 0) {
            await this.redisService.sadd(key, ...members);
          }
          await this.redisService.expire(key, GroupMembershipService.CACHE_TTL_SECONDS);
          totalRooms++;
          totalMembers += members.length;
        } catch (error: unknown) {
          const message = toErrorMessage(error);
          this.logger.warn(`写入群成员缓存失败 (room=${roomId}): ${message}`);
        }
      }

      // 分页判断：当前页不足 pageSize 即为最后一页
      hasMore = rooms.length >= pageSize;
      current++;
    }

    this.lastHydratedAt = Date.now();
    this.logger.log(
      `群成员缓存已预热: ${totalRooms}/${relevantRoomIds.size} 相关群 / ${totalMembers} 成员`,
    );
  }
  private buildKey(imRoomId: string): string {
    return `${GroupMembershipService.CACHE_KEY_PREFIX}:${imRoomId}`;
  }
}

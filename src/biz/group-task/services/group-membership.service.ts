import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomService } from '@channels/wecom/room/room.service';
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
 */
@Injectable()
export class GroupMembershipService {
  private readonly logger = new Logger(GroupMembershipService.name);

  private static readonly CACHE_KEY_PREFIX = 'room:members';
  private static readonly CACHE_TTL_SECONDS = 10 * 60;

  private readonly enterpriseToken: string | null;

  /** 防止并发 hydrate 重复请求 API */
  private hydratePromise: Promise<void> | null = null;
  /** 最近一次 hydrate 完成时间，用于快速判断是否已预热 */
  private lastHydratedAt = 0;

  constructor(
    private readonly redisService: RedisService,
    private readonly roomService: RoomService,
    configService: ConfigService,
  ) {
    this.enterpriseToken = configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || null;
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `检查群成员关系失败 (room=${imRoomId}, user=${userImContactId}): ${message}`,
      );
      return false;
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
      const message = error instanceof Error ? error.message : String(error);
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
      const message = error instanceof Error ? error.message : String(error);
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

    if (this.hydratePromise) return this.hydratePromise;

    this.hydratePromise = this.doHydrate(relevantRoomIds).finally(() => {
      this.hydratePromise = null;
    });
    return this.hydratePromise;
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
          const message = error instanceof Error ? error.message : String(error);
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

import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import type { ProceduralState } from '../types/procedural.types';

/**
 * 程序记忆服务 — 招聘流程阶段管理
 *
 * 管理 STAGE（Redis，SESSION_TTL）：
 * - 当前持久化阶段（下一轮会作为 entry stage 读出）
 * - 最近一次显式推进的 from/to、时间和原因（审计用）
 *
 * 写入策略：覆盖写（由 advance_stage 工具调用）
 *
 * 这里不做“阶段是否合理”的业务判断。
 * 合法性校验放在 advance_stage 工具层完成，
 * procedural service 只负责把最终通过校验的状态写进 Redis。
 */
@Injectable()
export class ProceduralService {
  private readonly logger = new Logger(ProceduralService.name);

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
  ) {}

  /** 读取当前 session 的程序记忆状态。不存在时返回统一空态。 */
  async get(corpId: string, userId: string, sessionId: string): Promise<ProceduralState> {
    const key = this.buildKey(corpId, userId, sessionId);
    const entry = await this.redisStore.get(key);
    if (!entry) return { currentStage: null, fromStage: null, advancedAt: null, reason: null };

    const content = entry.content as Record<string, unknown>;
    return {
      currentStage: (content.currentStage as string) ?? null,
      fromStage: (content.fromStage as string) ?? null,
      advancedAt: (content.advancedAt as string) ?? null,
      reason: (content.reason as string) ?? null,
    };
  }

  /**
   * 设置阶段状态（覆盖写）。
   *
   * 程序记忆只有一份最新状态，不保留 Redis 内部版本链；
   * 若需要追溯，依赖 fromStage / currentStage / advancedAt / reason。
   */
  async set(
    corpId: string,
    userId: string,
    sessionId: string,
    state: ProceduralState,
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    await this.redisStore.set(
      key,
      state as unknown as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
    this.logger.log(`阶段更新: ${state.currentStage} (user=${userId})`);
  }

  async clear(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    return await this.redisStore.del(this.buildKey(corpId, userId, sessionId));
  }

  // ---- 内部方法 ----

  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `stage:${corpId}:${userId}:${sessionId}`;
  }
}

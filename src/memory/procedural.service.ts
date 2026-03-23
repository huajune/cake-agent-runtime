import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from './stores/redis.store';
import { MemoryConfig } from './memory.config';
import type { ProceduralState } from './memory.types';

/**
 * 程序记忆服务 — 招聘流程阶段管理
 *
 * 管理 STAGE（Redis，SESSION_TTL）：
 * - 当前阶段标识（trust_building → needs_collection → job_recommendation → interview_arrangement）
 * - 推进时间和原因（审计用）
 *
 * 写入策略：覆盖写（由 advance_stage 工具调用）
 */
@Injectable()
export class ProceduralService {
  private readonly logger = new Logger(ProceduralService.name);

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
  ) {}

  /**
   * 获取当前阶段状态
   */
  async get(corpId: string, userId: string, sessionId: string): Promise<ProceduralState> {
    const key = this.buildKey(corpId, userId, sessionId);
    const entry = await this.redisStore.get(key);
    if (!entry) return { currentStage: null, advancedAt: null, reason: null };

    const content = entry.content as Record<string, unknown>;
    return {
      currentStage: (content.currentStage as string) ?? null,
      advancedAt: (content.advancedAt as string) ?? null,
      reason: (content.reason as string) ?? null,
    };
  }

  /**
   * 设置阶段状态（覆盖写）
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

  // ---- 内部方法 ----

  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `stage:${corpId}:${userId}:${sessionId}`;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import type { StageState } from '../types/stage-state.types';

/**
 * 阶段状态服务 — 招聘流程阶段管理
 *
 * 管理 STAGE（Redis，SESSION_TTL）：只持有当前阶段（下一轮会作为 entry stage 读出）。
 * 阶段变迁的审计链不在这里，见 stage-state.types 的说明。
 *
 * 写入策略：覆盖写（由 advance_stage 工具调用）
 *
 * 这里不做“阶段是否合理”的业务判断。
 * 合法性校验放在 advance_stage 工具层完成，
 * stageState service 只负责把最终通过校验的状态写进 Redis。
 */
@Injectable()
export class StageStateService {
  private readonly logger = new Logger(StageStateService.name);

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
  ) {}

  /** 读取当前 session 的阶段状态状态。不存在时返回统一空态。 */
  async get(corpId: string, userId: string, sessionId: string): Promise<StageState> {
    const key = this.buildKey(corpId, userId, sessionId);
    const entry = await this.redisStore.get(key);
    if (!entry) return { currentStage: null };

    const content = entry.content as Record<string, unknown>;
    // 旧记录里的 fromStage/advancedAt/reason 不再读出（S10）：它们只写不读，
    // 存量随会话 TTL 自然过期，无需迁移。
    return { currentStage: (content.currentStage as string) ?? null };
  }

  /**
   * 设置阶段状态（覆盖写）。
   *
   * 阶段状态只有一份最新状态，不保留 Redis 内部版本链；
   * 若需要追溯阶段变迁，看 advance_stage 的日志与 agent_execution_events。
   */
  async set(corpId: string, userId: string, sessionId: string, state: StageState): Promise<void> {
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

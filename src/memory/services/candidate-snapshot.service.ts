import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from '../stores/redis.store';
import {
  PRECHECK_SNAPSHOT_TTL_SECONDS,
  type PrecheckSnapshot,
} from '../facts/candidate/precheck-snapshot.types';

/**
 * PrecheckSnapshot 存取（方案 §4.3/§8 Phase 3）。
 *
 * Redis 单键单快照：precheck 成功即整体覆盖写（快照不可变，无 merge 语义），
 * TTL 到期自然失效。key 带 corpId/userId 隔离，precheckId 由调用方生成
 * （`pc_{turnId}_{jobId}`，Bull 重试同批重跑幂等覆盖同一键）。
 *
 * 读写失败均降级为 null/静默——快照闸当前是差异记录（shadow）形态，
 * Redis 抖动不得阻断报名主链路（与带外工单核验同款 fail open 语义）。
 */
@Injectable()
export class CandidateSnapshotService {
  private readonly logger = new Logger(CandidateSnapshotService.name);

  constructor(private readonly redisStore: RedisStore) {}

  private buildKey(corpId: string, userId: string, precheckId: string): string {
    return `precheck-snapshot:${corpId}:${userId}:${precheckId}`;
  }

  async save(corpId: string, userId: string, snapshot: PrecheckSnapshot): Promise<void> {
    try {
      await this.redisStore.set(
        this.buildKey(corpId, userId, snapshot.precheckId),
        snapshot as unknown as Record<string, unknown>,
        PRECHECK_SNAPSHOT_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `[candidate-snapshot] 保存失败（fail open）: ${snapshot.precheckId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async load(corpId: string, userId: string, precheckId: string): Promise<PrecheckSnapshot | null> {
    try {
      const entry = await this.redisStore.get(this.buildKey(corpId, userId, precheckId));
      if (!entry?.content) return null;
      const snapshot = entry.content as unknown as PrecheckSnapshot;
      return typeof snapshot.precheckId === 'string' && snapshot.effectiveProfile ? snapshot : null;
    } catch (error) {
      this.logger.warn(
        `[candidate-snapshot] 读取失败（fail open）: ${precheckId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

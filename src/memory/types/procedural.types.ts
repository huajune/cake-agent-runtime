import type { MemoryEntry } from '../stores/store.types';

/** 程序记忆 — 招聘流程阶段状态 */
export interface ProceduralState {
  /** 当前这段会话停留在哪个业务阶段。 */
  currentStage: string | null;
  /** 最近一次显式推进时，推进前所在的阶段。 */
  fromStage: string | null;
  /** 最近一次通过 advance_stage 显式推进阶段的时间。 */
  advancedAt: string | null;
  /** 最近一次推进阶段时记录的原因。 */
  reason: string | null;
}

/** Redis 中 procedural 层实际存储的 entry 结构。 */
export type ProceduralRedisEntry = MemoryEntry<ProceduralState>;

/** 程序记忆层的真实持久化结果。 */
export interface ProceduralStorageResult {
  source: 'redis';
  keyPattern: 'stage:{corpId}:{userId}:{sessionId}';
  entry: ProceduralRedisEntry | null;
}

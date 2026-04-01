import type { UserProfile } from './long-term.types';
import type { ProceduralState } from './procedural.types';
import type { ShortTermMessage } from './short-term.types';
import type { EntityExtractionResult, WeworkSessionState } from './session-facts.types';

/**
 * Agent 运行时记忆上下文 — memory.onTurnStart() 返回值
 *
 * 对外概念上仍然按四类记忆理解：
 * - 短期记忆
 * - 会话记忆
 * - 程序记忆
 * - 长期记忆
 *
 * 这是编排层/提示词层使用的运行时拼装结果，
 * 不是数据库或 Redis 中的原始存储结构。
 *
 * 运行时直接按四类记忆返回，避免和存储层类型产生双重“总览”概念。
 */
export interface MemoryRecallContext {
  shortTerm: {
    messageWindow: ShortTermMessage[];
  };
  sessionMemory: WeworkSessionState | null;
  /** 仅对当前轮生效的前置高置信识别结果，不属于持久化会话记忆。 */
  highConfidenceFacts: EntityExtractionResult | null;
  procedural: ProceduralState;
  longTerm: {
    profile: UserProfile | null;
  };
}

/** 兼容旧命名，后续逐步收口到 MemoryRecallContext。 */
export type AgentMemoryContext = MemoryRecallContext;

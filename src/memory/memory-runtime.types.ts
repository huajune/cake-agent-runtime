import type { SemanticMemory } from './long-term/long-term.types';
import type { StageState } from './short-term/short-term.types';
import type { ShortTermMessage } from './short-term/short-term.types';
import type { WeworkSessionState } from './short-term/short-term.types';
import type { TurnHints } from '@resolution/evidence/claim.types';

/**
 * Agent 运行时记忆上下文 — memory.onTurnStart() 返回值
 *
 * 对外概念上仍然按四类记忆理解：
 * - 短期记忆
 * - 会话记忆
 * - 阶段状态
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
  /** 记忆子系统的诊断警告（非用户可见）。 */
  _warnings?: string[];
  sessionMemory: WeworkSessionState | null;
  /** 仅对当前轮生效的前置高置信识别结果，不属于持久化会话记忆。 */
  turnHints: TurnHints | null;
  stageState: StageState;
  longTerm: {
    /** 语义记忆分组（CoALA A3）：跨会话稳定事实；类型定义见 long-term.types。 */
    semantic: SemanticMemory;
  };
}

/** 兼容旧命名，后续逐步收口到 MemoryRecallContext。 */
export type AgentMemoryContext = MemoryRecallContext;

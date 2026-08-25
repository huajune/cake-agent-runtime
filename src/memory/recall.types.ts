import type { SemanticMemory } from './long-term/long-term.types';
import type { StageState } from './short-term/short-term.types';
import type { ShortTermMessage } from './short-term/short-term.types';
import type { WeworkSessionState } from './short-term/short-term.types';
import type { TurnHints } from '@resolution/evidence/claim.types';
import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate/types';

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

// ==================== 主动复聊召回投影 ====================

// 信封唯一定义在 @resolution/candidate/types；此处仅作存储侧别名转发，
// 供 memory/reengagement 消费，不在本文件重新定义字段形状。
export type { CandidateFieldKey };
export type CollectedField<T = string | number> = CandidateCollectedField<T>;

export interface PresentedStore {
  storeId?: number | string;
  jobId: number;
  presentedAt?: number;
}

export interface ReengagementSessionState {
  collectedFields: Partial<Record<CandidateFieldKey, CollectedField>>;
  recalledJobIds: Set<number>;
  hardConstraints: Array<{
    kind: 'shift' | 'duration' | 'location' | 'household' | 'other';
    value: string;
    source: 'candidate' | 'precheck';
  }>;
  presentedStores: PresentedStore[];
  /** 本次求职会话累计推店轮次；用于同场景第二轮起升级收口。 */
  storePresentationRounds?: number;
  /** 本会话已成功邀请/核验在群的记录；复聊到点核验据此停止推店未回。 */
  invitedGroups?: Array<{
    groupName: string;
    city: string;
    industry?: string;
    invitedAt: string;
  }>;
  stage: string | null;
  lastCandidateMessageAt?: number;
  /**
   * 已被系统成功处理（正常回复或有意沉默）的候选人消息时间水位。
   * lastCandidateMessageAt 在入站接收层就写入，timeout 静默丢弃的消息也会计入；
   * 复聊停止判定须比对此水位，才能区分「已回话且被回应」与「回话被静默吞掉」。
   */
  lastProcessedCandidateMessageAt?: number;
  terminal?: import('./short-term/short-term.types').SessionTerminalState;
}

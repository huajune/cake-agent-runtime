import type { LongTermMemory, SemanticMemory } from './long-term/long-term.types';
import type { StageState } from './short-term/short-term.types';
import type { ShortTermMessage } from './short-term/short-term.types';
import type { ShortTermMemoryStructure } from './short-term/short-term.types';
import type { WeworkSessionState } from './short-term/short-term.types';
import type { TurnHints } from '@resolution/evidence/claim.types';
import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate/types';

// ==================== 0. 记忆系统总览（从这里读） ====================

/**
 * memory 的完整两层结构图。
 *
 * 这是类型级目录，不是一次调用返回的 DTO：short-term 的三个部件来自不同存储入口，
 * long-term 的 episodic 又只通过 recall_history 按需读取。实际每轮返回值见下方
 * MemoryRecallContext，它是这张完整地图的默认召回投影。
 */
export interface MemoryStructure {
  shortTerm: ShortTermMemoryStructure;
  longTerm: LongTermMemory;
}

// ==================== 1. 默认召回投影 ====================

/**
 * Agent 运行时记忆上下文 — memory.onTurnStart() 返回值
 *
 * 按两层记忆（short-term / long-term）组织，并在顶层携带本轮 sidecar。
 * 这是编排层/提示词层使用的运行时拼装结果，不是数据库或 Redis
 * 中的原始存储结构。
 */
export interface MemoryRecallContext {
  shortTerm: {
    messageWindow: ShortTermMessage[];
    /** chatId 维度的结构化会话状态（facts + workbench）。 */
    sessionState: WeworkSessionState | null;
    /** 阶段是会话状态部件；因保留独立 Redis key，在 shortTerm 中与 sessionState 并列注入。 */
    stage: StageState;
  };
  /** 记忆子系统的诊断警告（非用户可见）。 */
  _warnings?: string[];
  /** 仅对当前轮生效的前置高置信识别结果；它是轮作用域 sidecar，不是记忆层。 */
  turnHints: TurnHints | null;
  longTerm: {
    /** 语义记忆分组（CoALA A3）：跨会话稳定事实；类型定义见 long-term.types。 */
    semantic: SemanticMemory;
  };
  // episodic 摘要不进入默认召回；需要时由显式 recall_history 路径按需读取。
}

/** TODO(M5-followup): 兼容旧命名，待调用方全部收口后移除。 */
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

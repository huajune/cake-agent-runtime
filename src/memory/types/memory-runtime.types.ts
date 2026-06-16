import type { LongTermPreferenceFacts, UserProfileFacts } from './long-term.types';
import type { ProceduralState } from './procedural.types';
import type { ShortTermMessage } from './short-term.types';
import type { HighConfidenceFacts, WeworkSessionState } from './session-facts.types';

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
  /** 记忆子系统的诊断警告（非用户可见）。 */
  _warnings?: string[];
  sessionMemory: WeworkSessionState | null;
  /** 仅对当前轮生效的前置高置信识别结果，不属于持久化会话记忆。 */
  highConfidenceFacts: HighConfidenceFacts | null;
  procedural: ProceduralState;
  longTerm: {
    profile: UserProfileFacts | null;
    /** 跨会话沉淀的求职意向快照（settlement 写入，仅供模型参考，不进工具预填）。 */
    preferences?: LongTermPreferenceFacts | null;
    /**
     * 长期记忆来源研判。双 bot 服务同一候选人时，本轮注入的长期画像/意向
     * 可能来自候选人此前在另一个会话（另一位招募经理）的沉淀。
     */
    origin?: {
      /**
       * 当前为全新会话首聊，且注入的长期记忆来自其它会话（另一位招募经理）。
       * 为 true 时渲染层会给模型加"来自此前会话"的口径说明，避免假装是本会话聊过。
       */
      fromOtherConversation: boolean;
    };
  };
}

/** 兼容旧命名，后续逐步收口到 MemoryRecallContext。 */
export type AgentMemoryContext = MemoryRecallContext;

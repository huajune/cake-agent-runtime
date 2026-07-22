import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';
import type {
  BrandIntentPolarity,
  BrandMatchType,
  BrandResolutionSource,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';

/**
 * Agent 事件观测接口（对标 ZeroClaw Observer）。
 *
 * 这里的事件不是普通应用日志，而是一次 Agent 执行过程可查询、可下钻的结构化事实。
 * traceId 与 message_processing_records.message_id 同源，用于把消息主账本、执行事件、
 * 守卫审查档案串成同一条处理链。
 */

export interface AgentEventContext {
  traceId?: string;
  chatId?: string;
  userId?: string;
  corpId?: string;
  scenario?: string;
  callerKind?: string;
  timestamp?: number;
}

export type AgentEvent = AgentEventContext &
  (
    | { type: 'agent_start'; userId?: string; corpId?: string; scenario?: string }
    | {
        type: 'agent_end';
        userId?: string;
        steps?: number;
        totalTokens?: number;
        durationMs: number;
      }
    | { type: 'agent_error'; userId?: string; error: string }
    | {
        type: 'agent_stream_timing';
        messageId: string;
        sessionId: string;
        userId?: string;
        scenario?: string;
        status: 'success' | 'failure';
        timeToStreamReadyMs?: number;
        timeToFirstChunkMs?: number;
        timeToFirstReasoningMs?: number;
        timeToFirstTextMs?: number;
        streamDurationMs?: number;
        totalDurationMs: number;
        totalTokens?: number;
        error?: string;
      }
    | { type: 'model_call'; modelId: string; role: string }
    | { type: 'model_fallback'; fromModel: string; toModel: string; reason: string }
    /**
     * 出站语义评审执行档案（shadow / enforce 各发一条）：承担是否运行、通过量与
     * finding code 统计；完整判例与证据归档在 guardrail_review_records。
     */
    | {
        type: 'semantic_review';
        mode: 'shadow' | 'enforce';
        decision: string;
        confidence: string;
        findingCodes: string[];
      }
    | {
        type: 'tool_call';
        toolName: string;
        userId?: string;
        durationMs?: number;
        status?: AgentToolCallStatus;
        resultCount?: number;
        sideEffect?: boolean;
      }
    | { type: 'tool_error'; toolName: string; error: string; durationMs?: number }
    | { type: 'memory_recall'; userId: string; found: boolean }
    | { type: 'memory_store'; userId: string; keys: string[] }
    /**
     * 会话品牌状态迁移（§12 长期事件）：前后快照 + 触发它的解析结果。
     * 仅状态实际变化时发射；它是品牌链路上唯一不可重放的信息，并承担历史回放职责。
     */
    | {
        type: 'brand_state_change';
        userId?: string;
        prev: SessionBrandState | null;
        next: SessionBrandState;
        /**
         * 触发本次迁移的解析结果。matchedText（命中的品牌库词条）与 sourceText（用户原文
         * 片段）是误命中归因的必需项：只有 matchType + canonicalName 时，脏别名塌缩与候选人
         * 真实简称在事件里长得一模一样，日检必须回查 chat_messages 才能分真假阳性。
         */
        triggers: Array<{
          source: BrandResolutionSource;
          polarity: BrandIntentPolarity;
          canonicalName: string | null;
          matchType: BrandMatchType | null;
          matchedText: string | null;
          sourceText: string | null;
          confidence: number;
        }>;
        /** 本次写入是否首次初始化（懒迁移/seed）。 */
        initialized?: boolean;
        /** 是否异步补写（§10.3）晚到落状态。 */
        late?: boolean;
      }
    /**
     * 歧义品牌词形现场（§12 长期事件，补 §18 观测债）：冲突别名命中（如「小龙」→
     * 小龙坎/小龙翻大江）按设计不写状态，而 brand_state_change 仅状态变化时发射——
     * 纯歧义轮因此整档零留痕（2026-07-21 发现）。本事件在解析结果入口无条件记录，
     * 不依赖状态是否变化；量级与冲突别名出现频率同阶（每天个位数）。
     */
    | {
        type: 'brand_resolution_ambiguous';
        userId?: string;
        items: Array<{
          source: BrandResolutionSource;
          matchedText: string | null;
          sourceText: string | null;
          polarity: BrandIntentPolarity;
          candidates: Array<{ canonicalName: string; brandId: number | null }>;
        }>;
        /** 是否图片补写（§10.3）路径。 */
        late: boolean;
      }
  );

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

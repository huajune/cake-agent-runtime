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
        triggers: Array<{
          source: BrandResolutionSource;
          polarity: BrandIntentPolarity;
          canonicalName: string | null;
          matchType: BrandMatchType | null;
          confidence: number;
        }>;
        /** 本次写入是否首次初始化（懒迁移/seed）。 */
        initialized?: boolean;
        /** 是否异步补写（§10.3）晚到落状态。 */
        late?: boolean;
      }
    /**
     * 新旧品牌匹配路径差异（§12 临时事件，随旧路径下线删除）：
     * 品牌目录时变、离线重放无法复现，差异现场必须在线记录；一致时仅计数不落行。
     */
    | {
        type: 'brand_resolution_shadow_diff';
        userId?: string;
        inputs: string[];
        legacyBrands: string[];
        nextBrands: string[];
        catalogSize: number;
        origin: 'extraction_hints' | 'contact_name';
      }
  );

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

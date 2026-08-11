import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';
import type {
  BrandIntentPolarity,
  BrandMatchType,
  BrandResolutionSource,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';
import type { ToolErrorType } from '@tools/types/tool-error-types';
import type {
  CandidateClaimDecision,
  CandidateClaimField,
  CandidateFactProducer,
  CandidateClaimRejectionReason,
  CandidateFactInterpretation,
  CandidateFactOperation,
} from '@resolution/evidence/claim.types';
import type { ValidLaborForm } from '@resolution/labor-form';

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
        /**
         * buildToolError 的机器可读错误分类；成功态为 undefined（见 extractToolErrorType）。
         * 类型复用 tool-error-types 的单一权威枚举 ToolErrorType，不另立字符串。
         */
        errorType?: ToolErrorType;
        /**
         * 工具透传的下游接口返回码（如海绵业务 code 30003）；仅业务拒绝态携带（见 extractToolApiCode）。
         * 这是外部系统（海绵）的开放码域、非本仓库领域枚举，故保持 string | number 原样，不本地枚举化。
         */
        apiCode?: string | number;
      }
    | { type: 'tool_error'; toolName: string; error: string; durationMs?: number }
    | { type: 'memory_recall'; userId: string; found: boolean }
    | { type: 'memory_store'; userId: string; keys: string[] }
    /**
     * 会话品牌状态迁移（§12 长期事件）：前后快照 + 触发它的解析结果。
     * 仅状态实际变化时发射；它是品牌链路上不可重放信息之一（另一类见 brand_resolution_ambiguous），承担历史回放职责。
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
    /**
     * 抽取臆造字段拦截（is_student 首写证据门等，badcase 2026-07-28 chat 6a673402…）：
     * 首写无会话证据的身份字段被字段级丢弃。正常量级应接近零，持续出现即抽取
     * 模型指令遵循劣化信号，日巡检据此核对。
     */
    | {
        type: 'extraction_field_dropped';
        userId?: string;
        field: string;
        droppedValue: string;
        reason: string;
      }
    /**
     * 封闭语义标签的双轨 shadow 分歧：仅分歧时落档，绝不改变规则轨生效结果。
     * traceId 由 AgentTracer 的请求上下文补齐，可与消息主账本直接 join。
     */
    | {
        type: 'semantic_track_diff';
        semantic: 'labor_form_intent';
        userId?: string;
        ruleTrack:
          | { intent: 'set'; laborForm: ValidLaborForm }
          | { intent: 'clear'; laborForms: ValidLaborForm[] }
          | { intent: 'ignore' };
        extractionTrack: {
          intent: 'set' | 'clear' | 'ignore';
          laborForm?: ValidLaborForm;
        };
        quote: string;
      }
    /**
     * 候选人事实裁决档案（证据化方案 §11）：precheck 每次裁决一条、booking
     * 快照对账不一致时一条。decisions 刻意不携带字段值与 quote 原文（PII 纪律，
     * 方案 §11"完整证据仅进入受控审计存储"）——值本体可经 trace_id join
     * message_processing_records 的工具入参回查。
     */
    | {
        type: 'fact_adjudication';
        stage: 'precheck' | 'booking_gate';
        mode: 'shadow' | 'enforce';
        userId?: string;
        precheckId?: string;
        factsVersion?: number;
        // 六个字段一律复用裁决域权威类型，不另立 string（与本文件 errorType 用
        // ToolErrorType 同口径）：观测字段与产出方漂移会让日巡检按错的取值集聚合，
        // 而裸 string 下这种漂移零信号。
        decisions: Array<{
          field: CandidateClaimField;
          producer: CandidateFactProducer;
          operation: CandidateFactOperation;
          interpretation: CandidateFactInterpretation;
          decision: CandidateClaimDecision;
          rejectionReason?: CandidateClaimRejectionReason;
          supersededByClaimId?: string;
          claimId: string;
        }>;
        /** booking_gate 专用：payload 与快照不一致的字段名（含水位失效伪字段）。 */
        mismatchedFields?: string[];
      }
  );

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';
import type {
  BrandIntentPolarity,
  BrandMatchType,
  BrandResolutionSource,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';
import type { ToolErrorType } from '@tools/shared/tool-error-types';
import type { ErrorCategory } from '@providers/types';

/**
 * llm-executor 单次 provider 尝试的轨迹条目。
 *
 * `attempt=0` 表示候选模型在真正发起请求前被预检跳过（不支持图片输入 / provider 未注册），
 * `attempt>=1` 表示一次真实的 generateText/streamText 调用。error 为截断后的错误消息或
 * 跳过原因，不含 prompt/响应体全文，避免 PII 进观测。
 */
export interface LlmAttemptTrace {
  modelId: string;
  attempt: number;
  /** 相对本次 llm-executor 调用入口的开始偏移（ms）。 */
  startOffsetMs: number;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  /** reliable.classifyError 三分类；success/skipped 时缺省。 */
  errorCategory?: ErrorCategory;
  error?: string;
  /** 本次失败后进入的指数退避等待（ms）；最后一次失败/不重试时缺省。 */
  backoffMs?: number;
}

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
        /**
         * 前缀缓存命中的输入 token（prompt_tokens_details.cached_tokens 求和）。
         * 缓存命中率（cachedTokens / 输入量）是生产 agent 的核心健康指标；
         * undefined = provider 未上报。
         */
        cachedTokens?: number;
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
     * llm-executor 单次调用（generate/stream）的完整尝试轨迹（2026-08-31 慢回合事故）：
     * 同模型静默重试此前完全不可见——成功即丢弃 attempts 内存轨迹、重试只有 logger.warn、
     * agent_steps 的墙钟锚跨尝试错位——生产曾出现 ai_duration 207s 而 agent_steps 只记 31s、
     * 全链路零观测记录。本事件在每次执行收尾（成功或全链耗尽）无条件发射并落库，
     * 让"每次 provider 尝试的开始/耗时/错误分类/退避"可按 traceId 下钻。
     *
     * stream 模式的 totalDurationMs 只覆盖初始化窗口（streamText 同步返回），
     * 不含流式消费耗时；重试期间进程被 SIGTERM 打断时本事件不发射（收尾点埋点的固有盲区）。
     */
    | {
        type: 'llm_execution';
        userId?: string;
        role: string;
        mode: 'generate' | 'stream';
        primaryModelId: string;
        /** 最终成功返回结果的模型；全链耗尽为 null。 */
        finalModelId: string | null;
        status: 'success' | 'exhausted';
        /** 真实发起的 provider 请求次数（不含预检跳过）。 */
        attemptCount: number;
        totalDurationMs: number;
        /** 重试退避 sleep 累计（ms）。 */
        backoffTotalMs: number;
        attempts: LlmAttemptTrace[];
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
     * 会话状态字段落盘态与 schema 失配、被逐字段校验丢弃。
     *
     * 这是**存量数据**与代码 schema 对不上（存储完整性），不是模型提取值的业务准入
     * 判定。跨版本词表漂移、脏写、回滚到旧代码读新数据都会命中。Redis 是 facts /
     * terminal / facts（含 brand）的唯一事实源，丢一个字段就是丢一段事实，正常量级应恒为零。
     */
    | {
        type: 'session_state_field_dropped';
        userId?: string;
        /** 被丢弃的顶层字段（facts / terminal …）。 */
        field: string;
        /** zod 失败明细（字段路径 + 原因），不含值本体，避免 PII 进观测。 */
        issues: string[];
      }
    /**
     * 收资表单一轮的审计条目（蓝图 §4）：公证拒收 / 判不合格 / 显式改口 / 配置债 /
     * 熔断各一条。拒收事件是**臆造防线的观测面**——只打日志等于这道防线没有验收数据。
     */
    | {
        type: 'collection_form_audit';
        userId?: string;
        jobId: number;
        kind: string;
        labelId?: number;
        reason?: string;
        channel?: string;
        detail?: string;
      }
    /**
     * 身份锚点核验不过：环境配置说某 labelId 是身份槽，契约里该 id 的标题却对不上
     * ——标签表重建后的静默断链（D4 撤回"把 ID 写进文档"诉求时点名要防的事故）。
     * 该槽已降通用道，不阻断收资；量级应恒为零，非零即配置漂了。
     */
    | {
        type: 'collection_identity_anchor_mismatch';
        userId?: string;
        labelId: number;
        expected: string;
        labelTitle: string;
      }
    /**
     * 岗位契约返回空标签 = 数据异常（0820 后端确认正常在招岗必有标签）。
     * 已按裁定转人工；本事件是"到底有多少岗在返空"的唯一量化来源。
     */
    | {
        type: 'collection_empty_contract';
        userId?: string;
        jobId: number;
      }
  );

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

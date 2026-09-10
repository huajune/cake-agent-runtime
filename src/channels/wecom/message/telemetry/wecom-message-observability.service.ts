import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import type { GuardrailInputTrace, GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';
import {
  AgentInvokeResult,
  DeliveryResult,
  AlertErrorType,
  StorageContactType,
  StorageMessageSource,
  StorageMessageType,
  toStorageContactType,
  toStorageMessageSource,
  toStorageMessageType,
} from '../types';
import { MessageTraceStoreService } from './message-trace-store.service';
import { buildWecomTimingSummary, type WecomTraceTimings } from './wecom-trace-timing.util';

type DispatchMode = 'direct' | 'merged' | 'disabled';

interface FallbackDeliverySummary {
  attempted: boolean;
  success?: boolean;
  message?: string;
  totalTime?: number;
  deliveredSegments?: number;
  failedSegments?: number;
  error?: string;
}

interface WecomTraceRequestContext {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  botUserId?: string;
  imBotId?: string;
  scenario: ScenarioType;
  content: string;
  imageCount: number;
  messageType?: StorageMessageType;
  messageSource?: StorageMessageSource;
  contactType?: StorageContactType;
  dispatchMode?: DispatchMode;
  batchId?: string;
  acceptedAt?: number;
  sourceMessageIds?: string[];
  sourceMessageCount?: number;
  sourceMessageLastAcceptedAt?: number;
  quietWindowEligibleAt?: number;
}

interface WecomTraceContext {
  request: WecomTraceRequestContext;
  timings: WecomTraceTimings;
  agentRequest?: Record<string, unknown>;
  agentResult?: AgentInvokeResult;
  deliveryResult?: DeliveryResult;
  fallbackDelivery?: FallbackDeliverySummary;
}

interface SuccessMetadataOptions {
  scenario: ScenarioType;
  batchId?: string;
  replySegments?: number;
  replyPreview?: string;
  extraResponse?: Record<string, unknown>;
  /** 入站守卫转人工摘要（handoff 收尾时由渠道传入，写 guardrail_input 列）。 */
  guardrailInput?: GuardrailInputTrace;
  /** 出站守卫全程 trace（渠道显式传入时优先；否则回退 agentResult.guardrailOutput）。 */
  guardrailOutput?: GuardrailTurnTrace;
}

interface FailureMetadataOptions {
  scenario: ScenarioType;
  errorType: AlertErrorType;
  errorMessage: string;
  batchId?: string;
  extraResponse?: Record<string, unknown>;
}

type TerminalMetadata = MonitoringMetadata & {
  alertType?: AlertErrorType;
  fallbackSuccess?: boolean;
  batchId?: string;
};

interface StartMessageTraceParams {
  traceId: string;
  primaryMessage: EnterpriseMessageCallbackDto;
  scenario: ScenarioType;
  content: string;
  batchId?: string;
  allMessages?: EnterpriseMessageCallbackDto[];
  mergeWindowMs?: number;
}

@Injectable()
export class WecomMessageObservabilityService {
  private readonly logger = new Logger(WecomMessageObservabilityService.name);

  constructor(
    private readonly trackingService: MessageTrackingService,
    private readonly traceStore: MessageTraceStoreService,
  ) {}

  async startTrace(context: WecomTraceRequestContext): Promise<void> {
    const acceptedAt = context.acceptedAt ?? Date.now();
    await this.traceStore.set(context.messageId, {
      request: context,
      timings: { acceptedAt },
    });

    this.trackingService.recordMessageReceived(
      context.messageId,
      context.chatId,
      context.userId,
      context.userName,
      context.content,
      { scenario: context.scenario, batchId: context.batchId },
      context.managerName,
      acceptedAt,
      {
        botUserId: context.botUserId ?? context.managerName,
        imBotId: context.imBotId,
      },
    );
  }

  async startRequestTrace(params: StartMessageTraceParams): Promise<void> {
    const { traceId, primaryMessage, scenario, content, batchId, allMessages, mergeWindowMs } =
      params;
    const parsed = MessageParser.parse(primaryMessage);
    const messages = allMessages ?? [primaryMessage];
    const imageCount = messages.filter((message) => MessageParser.extractImageUrl(message)).length;
    const acceptedAt = this.resolveAcceptedAt(messages);
    const sourceMessageLastAcceptedAt = this.resolveLatestAcceptedAt(messages);
    const quietWindowEligibleAt =
      sourceMessageLastAcceptedAt !== undefined &&
      mergeWindowMs !== undefined &&
      Number.isFinite(mergeWindowMs)
        ? sourceMessageLastAcceptedAt + Math.max(mergeWindowMs, 0)
        : undefined;

    await this.startTrace({
      messageId: traceId,
      chatId: parsed.chatId,
      userId: parsed.imContactId,
      userName: parsed.contactName,
      managerName: parsed.managerName,
      botUserId: primaryMessage.botUserId ?? parsed.managerName,
      imBotId: parsed.imBotId,
      scenario,
      content,
      imageCount,
      messageType: toStorageMessageType(primaryMessage.messageType),
      messageSource: toStorageMessageSource(primaryMessage.source),
      contactType: toStorageContactType(primaryMessage.contactType),
      batchId,
      acceptedAt,
      sourceMessageIds: messages.map((message) => message.messageId),
      sourceMessageCount: messages.length,
      sourceMessageLastAcceptedAt,
      quietWindowEligibleAt,
    });
  }

  buildMergedRequestContent(messages: EnterpriseMessageCallbackDto[]): string {
    const parts = messages
      .map((message) => MessageParser.extractContent(message)?.trim())
      .filter((content): content is string => Boolean(content));

    if (parts.length === 0) {
      return '[聚合消息]';
    }

    if (parts.length === 1) {
      return parts[0];
    }

    return parts.join('\n');
  }

  async updateRequestMessages(
    messageId: string,
    params: {
      messages: EnterpriseMessageCallbackDto[];
      content: string;
      mergeWindowMs?: number;
    },
  ): Promise<void> {
    const trace = await this.traceStore.getFields<WecomTraceContext, 'request'>(messageId, [
      'request',
    ]);
    if (!trace?.request) return;

    const { messages, content, mergeWindowMs } = params;
    const imageCount = messages.filter((message) => MessageParser.extractImageUrl(message)).length;
    const acceptedAt = this.resolveEarliestAcceptedAt(messages);
    const sourceMessageLastAcceptedAt = this.resolveLatestAcceptedAt(messages);
    const quietWindowEligibleAt =
      sourceMessageLastAcceptedAt !== undefined &&
      mergeWindowMs !== undefined &&
      Number.isFinite(mergeWindowMs)
        ? sourceMessageLastAcceptedAt + Math.max(mergeWindowMs, 0)
        : undefined;

    trace.request.content = content;
    trace.request.imageCount = imageCount;
    trace.request.sourceMessageIds = messages.map((message) => message.messageId);
    trace.request.sourceMessageCount = messages.length;
    if (acceptedAt !== undefined) {
      trace.request.acceptedAt = acceptedAt;
    }
    trace.request.sourceMessageLastAcceptedAt = sourceMessageLastAcceptedAt;
    trace.request.quietWindowEligibleAt = quietWindowEligibleAt;

    await this.traceStore.patch<WecomTraceContext>(messageId, { request: trace.request });
    if (acceptedAt !== undefined) {
      await this.traceStore.patchTimings<WecomTraceTimings>(messageId, { acceptedAt });
    }
  }

  async hasTrace(messageId: string): Promise<boolean> {
    return this.traceStore.exists(messageId);
  }

  async updateDispatch(
    messageId: string,
    dispatchMode: DispatchMode,
    batchId?: string,
  ): Promise<void> {
    const trace = await this.traceStore.getFields<WecomTraceContext, 'request'>(messageId, [
      'request',
    ]);
    if (!trace?.request) return;
    trace.request.dispatchMode = dispatchMode;
    trace.request.batchId = batchId ?? trace.request.batchId;
    await this.traceStore.patch<WecomTraceContext>(messageId, { request: trace.request });
  }

  async markHistoryStored(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'historyStoredAt');
  }

  async markImagePrepared(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'imagePreparedAt');
  }

  async markQueueAdd(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'queueAddAt', true);
  }

  async markWorkerStart(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'workerStartAt', true);
  }

  /**
   * 合并多条源消息 trace 的前置埋点到目标 trace（常用于 batch 场景）
   * - historyStoredAt 取最大值（批内最后一条完成写历史的时间）
   * - imagePreparedAt 取最大值
   * - queueAddAt 取最大值（最后入队那次）
   */
  async mergePrepTimingsFromSources(
    targetTraceId: string,
    sourceMessageIds: string[],
  ): Promise<void> {
    if (!sourceMessageIds.length) return;
    const timingFields: ('historyStoredAt' | 'imagePreparedAt' | 'queueAddAt')[] = [
      'historyStoredAt',
      'imagePreparedAt',
      'queueAddAt',
    ];
    const target = await this.traceStore.getTimings<
      WecomTraceTimings,
      'historyStoredAt' | 'imagePreparedAt' | 'queueAddAt'
    >(targetTraceId, timingFields);
    if (!target) return;

    const sources = await Promise.all(
      sourceMessageIds.map((id) =>
        this.traceStore.getTimings<
          WecomTraceTimings,
          'historyStoredAt' | 'imagePreparedAt' | 'queueAddAt'
        >(id, timingFields),
      ),
    );

    const maxOf = (
      field: 'historyStoredAt' | 'imagePreparedAt' | 'queueAddAt',
    ): number | undefined => {
      const values = sources
        .map((timings) => timings?.[field])
        .filter((value): value is number => Number.isFinite(value ?? NaN));
      return values.length ? Math.max(...values) : undefined;
    };

    const historyStoredAt = maxOf('historyStoredAt');
    const imagePreparedAt = maxOf('imagePreparedAt');
    const queueAddAt = maxOf('queueAddAt');

    if (historyStoredAt !== undefined) target.historyStoredAt = historyStoredAt;
    if (imagePreparedAt !== undefined) target.imagePreparedAt = imagePreparedAt;
    if (queueAddAt !== undefined) target.queueAddAt = queueAddAt;

    await this.traceStore.patchTimings(targetTraceId, target);

    const recyclableSourceIds = sourceMessageIds.filter((id) => id !== targetTraceId);

    // 源 trace 已贡献完前置埋点，清理掉避免 Redis 积压
    await Promise.all(
      recyclableSourceIds.map((id) => this.traceStore.delete(id).catch(() => undefined)),
    );

    // 源 messageId 在 intake 时已落了一条 processing 流水，聚合 trace 接手后这些源行
    // 不会再走到终态。异步删掉避免在监控页留下永远「处理中」的孤儿。
    // Fire-and-forget: 源记录清理不在回复关键路径上，Supabase DELETE 的延迟
    // 不应阻塞 workerStartAt 和后续 Agent 调用。
    this.trackingService
      .dropMergedSourceRecords(recyclableSourceIds, targetTraceId)
      .catch((err) => {
        const message = toErrorMessage(err);
        this.logger.warn(`[聚合回收] 异步清理源记录失败 batchId=${targetTraceId}: ${message}`);
      });
  }

  async markAiStart(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'aiStartAt', true);
  }

  async markAiEnd(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'aiEndAt');
  }

  async recordAgentResult(messageId: string, agentResult: AgentInvokeResult): Promise<void> {
    if (!(await this.traceStore.exists(messageId))) return;
    await this.traceStore.patch<WecomTraceContext>(messageId, { agentResult });
  }

  async recordAgentRequest(messageId: string, request: Record<string, unknown>): Promise<void> {
    if (!(await this.traceStore.exists(messageId))) return;
    await this.traceStore.patch<WecomTraceContext>(messageId, { agentRequest: request });
  }

  async markDeliveryStart(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'deliveryStartAt', true);
  }

  async markFirstSegmentSent(messageId: string): Promise<void> {
    await this.markTiming(messageId, 'firstSegmentSentAt', true);
  }

  async markDeliveryEnd(messageId: string, deliveryResult: DeliveryResult): Promise<void> {
    if (!(await this.markTiming(messageId, 'deliveryEndAt'))) return;
    await this.traceStore.patch<WecomTraceContext>(messageId, { deliveryResult });
  }

  /**
   * 标记本轮为非 reply 终态（skip_reply 主动沉默/守卫拦截/handoff/工具短路），不发送任何消息。
   *
   * 仍写入 delivery 时间戳与零片段 deliveryResult，确保耗时统计与流水结构完整。
   */
  async markReplySkipped(messageId: string): Promise<void> {
    const timings = await this.traceStore.getTimings<
      WecomTraceTimings,
      'deliveryStartAt' | 'deliveryEndAt'
    >(messageId, ['deliveryStartAt', 'deliveryEndAt']);
    if (!timings) return;
    const now = Date.now();
    await Promise.all([
      this.traceStore.patchTimings<WecomTraceTimings>(messageId, {
        replySkippedAt: now,
        deliveryStartAt: timings.deliveryStartAt ?? now,
        deliveryEndAt: timings.deliveryEndAt ?? now,
      }),
      this.traceStore.patch<WecomTraceContext>(messageId, {
        deliveryResult: {
          success: true,
          segmentCount: 0,
          failedSegments: 0,
          deliveredSegments: 0,
          totalTime: 0,
        },
      }),
    ]);
  }

  async markFallbackStart(messageId: string, fallbackMessage: string): Promise<void> {
    if (!(await this.markTiming(messageId, 'fallbackStartAt'))) return;
    await this.traceStore.patch<WecomTraceContext>(messageId, {
      fallbackDelivery: { attempted: true, message: fallbackMessage },
    });
  }

  async markFallbackEnd(
    messageId: string,
    result: {
      success: boolean;
      totalTime?: number;
      deliveredSegments?: number;
      failedSegments?: number;
      error?: string;
    },
  ): Promise<void> {
    const trace = await this.traceStore.getFields<WecomTraceContext, 'fallbackDelivery'>(
      messageId,
      ['fallbackDelivery'],
    );
    if (!trace) return;
    await this.markTiming(messageId, 'fallbackEndAt');
    await this.traceStore.patch<WecomTraceContext>(messageId, {
      fallbackDelivery: {
        attempted: true,
        message: trace.fallbackDelivery?.message,
        success: result.success,
        totalTime: result.totalTime,
        deliveredSegments: result.deliveredSegments,
        failedSegments: result.failedSegments,
        error: result.error,
      },
    });
  }

  buildSuccessMetadata(
    messageId: string,
    options: SuccessMetadataOptions,
  ): Promise<TerminalMetadata> {
    return this.buildTerminalMetadata(messageId, { status: 'success', ...options });
  }

  buildFailureMetadata(
    messageId: string,
    options: FailureMetadataOptions,
  ): Promise<TerminalMetadata> {
    return this.buildTerminalMetadata(messageId, { status: 'failure', ...options });
  }

  /**
   * 终态 metadata 的唯一组装点：成功/失败只在「回复摘要取自渠道还是取自 agentResult」、
   * 「fallback 结论」与 response 的 status/error 三处分叉，其余字段同源。读完即清理 Redis trace。
   */
  private async buildTerminalMetadata(
    messageId: string,
    options:
      | ({ status: 'success' } & SuccessMetadataOptions)
      | ({ status: 'failure' } & FailureMetadataOptions),
  ): Promise<TerminalMetadata> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    const completedAt = Date.now();
    const agentResult = trace?.agentResult;
    const failure = options.status === 'failure' ? options : undefined;
    const success = options.status === 'success' ? options : undefined;
    const isFallback =
      agentResult?.isFallback ?? (failure ? Boolean(trace?.fallbackDelivery) : false);

    const metadata: TerminalMetadata = {
      scenario: options.scenario,
      batchId: options.batchId,
      alertType: failure?.errorType,
      replyPreview: failure ? agentResult?.reply.content : success?.replyPreview,
      replySegments: failure ? trace?.deliveryResult?.segmentCount : success?.replySegments,
      tokenUsage: agentResult?.reply.usage?.totalTokens ?? 0,
      toolCalls: agentResult?.toolCalls,
      agentSteps: agentResult?.agentSteps,
      guardrailInput: success?.guardrailInput,
      guardrailOutput: success?.guardrailOutput ?? agentResult?.guardrailOutput,
      memorySnapshot: agentResult?.memorySnapshot,
      isFallback,
      fallbackSuccess: failure ? trace?.fallbackDelivery?.success : isFallback ? true : undefined,
      agentInvocation: trace
        ? {
            request: {
              ...trace.request,
              agentRequest: trace.agentRequest,
            },
            response: {
              status: options.status,
              ...(failure ? { error: failure.errorMessage, errorType: failure.errorType } : {}),
              reply: {
                content: agentResult?.reply.content,
                reasoning: agentResult?.reply.reasoning,
                usage: agentResult?.reply.usage,
              },
              messages: agentResult?.responseMessages,
              toolCalls: agentResult?.toolCalls,
              // agentSteps / memorySnapshot 已作为顶层 metadata 字段写入独立列，
              // 不再嵌入 agent_invocation.response 避免每行 jsonb 体积翻倍。
              delivery: trace.deliveryResult,
              fallback: trace.fallbackDelivery,
              timings: buildWecomTimingSummary(
                trace.timings,
                trace.request.quietWindowEligibleAt,
                completedAt,
              ),
              ...options.extraResponse,
            },
            isFallback,
          }
        : undefined,
    };

    await this.cleanup(messageId);
    return metadata;
  }

  private resolveAcceptedAt(messages: EnterpriseMessageCallbackDto[]): number {
    return this.resolveEarliestAcceptedAt(messages) ?? Date.now();
  }

  private resolveEarliestAcceptedAt(messages: EnterpriseMessageCallbackDto[]): number | undefined {
    const candidates = messages
      .map((message) => message._receivedAtMs)
      .filter((value): value is number => Number.isFinite(value) && value > 0);

    if (candidates.length === 0) {
      return undefined;
    }

    return Math.min(...candidates);
  }

  private resolveLatestAcceptedAt(messages: EnterpriseMessageCallbackDto[]): number | undefined {
    const candidates = messages
      .map((message) => message._receivedAtMs)
      .filter((value): value is number => Number.isFinite(value) && value > 0);

    if (candidates.length === 0) {
      return undefined;
    }

    return Math.max(...candidates);
  }

  /** 原子更新单个 timing field；返回 true 表示本次确实写入（trace 不存在或 NX 已有值时 false）。 */
  private markTiming(
    messageId: string,
    field: keyof WecomTraceTimings,
    onlyIfAbsent = false,
  ): Promise<boolean> {
    return this.traceStore.setTiming(messageId, field, Date.now(), onlyIfAbsent);
  }

  private async cleanup(messageId: string): Promise<void> {
    await this.traceStore.delete(messageId);
    this.logger.debug(`[WecomTrace] 已清理 trace [${messageId}]`);
  }
}

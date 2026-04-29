import { Injectable, Logger } from '@nestjs/common';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import type { AgentTestFeedback, FeedbackSourceTrace } from './bitable-sync.service';

@Injectable()
export class FeedbackSourceTraceService {
  private readonly logger = new Logger(FeedbackSourceTraceService.name);

  constructor(private readonly messageProcessingService: MessageProcessingService) {}

  async build(feedback: AgentTestFeedback): Promise<FeedbackSourceTrace | null> {
    const processingRecord = await this.resolveFeedbackProcessingRecord(feedback);
    const recordTraceId = this.extractTraceId(processingRecord);
    const baseTrace = this.normalizeFeedbackSourceTrace({
      ...(feedback.sourceTrace ?? {}),
      chatIds: this.mergeLists(feedback.sourceTrace?.chatIds, feedback.chatId),
      anchorMessageIds: this.mergeLists(
        feedback.sourceTrace?.anchorMessageIds,
        feedback.messageId,
        processingRecord?.messageId,
      ),
      relatedMessageIds: this.mergeLists(
        feedback.sourceTrace?.relatedMessageIds,
        processingRecord?.messageId,
      ),
      messageProcessingIds: this.mergeLists(
        feedback.sourceTrace?.messageProcessingIds,
        processingRecord?.messageId,
      ),
      traceIds: this.mergeLists(feedback.sourceTrace?.traceIds, feedback.traceId, recordTraceId),
      batchIds: this.mergeLists(
        feedback.sourceTrace?.batchIds,
        feedback.batchId,
        processingRecord?.batchId,
      ),
      raw: this.compactObject({
        ...(feedback.sourceTrace?.raw ?? {}),
        feedback: this.compactObject({
          submittedVia: 'test-suite/feedback',
          type: feedback.type,
          errorType: feedback.errorType,
        }),
        messageProcessing: processingRecord
          ? this.summarizeProcessingRecord(processingRecord)
          : undefined,
      }),
    });

    return this.normalizeFeedbackSourceTrace(baseTrace);
  }

  stringifyCompact(value: unknown): string | undefined {
    const compacted = this.compactValue(value);
    return compacted === undefined ? undefined : JSON.stringify(compacted, null, 2);
  }

  private async resolveFeedbackProcessingRecord(
    feedback: AgentTestFeedback,
  ): Promise<MessageProcessingRecordInput | null> {
    const candidateMessageIds = this.mergeLists(
      feedback.messageId,
      feedback.sourceTrace?.anchorMessageIds,
      feedback.sourceTrace?.messageProcessingIds,
    );

    for (const messageId of candidateMessageIds) {
      const record = await this.safeGetMessageProcessingRecord(messageId);
      if (record) return record;
    }

    if (!feedback.chatId) return null;

    try {
      const records = await this.messageProcessingService.getMessageProcessingRecords({
        chatId: feedback.chatId,
        limit: '20',
      });
      const selected =
        this.pickBestProcessingRecord(records as MessageProcessingRecordInput[], feedback) ??
        (records as MessageProcessingRecordInput[])[0];

      if (!selected?.messageId) return null;
      return (await this.safeGetMessageProcessingRecord(selected.messageId)) ?? selected;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[Feedback] 查询 chatId=${feedback.chatId} 处理流水失败: ${errorMessage}`);
      return null;
    }
  }

  private async safeGetMessageProcessingRecord(
    messageId: string,
  ): Promise<MessageProcessingRecordInput | null> {
    try {
      return await this.messageProcessingService.getMessageProcessingRecordById(messageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[Feedback] 查询 messageId=${messageId} 处理流水失败: ${errorMessage}`);
      return null;
    }
  }

  private pickBestProcessingRecord(
    records: MessageProcessingRecordInput[],
    feedback: AgentTestFeedback,
  ): MessageProcessingRecordInput | null {
    if (!records.length) return null;
    const normalizedUserMessage = this.normalizeTextForMatch(feedback.userMessage);
    if (!normalizedUserMessage) return records[0];

    return (
      records.find((record) => {
        const preview = this.normalizeTextForMatch(record.messagePreview);
        return preview.includes(normalizedUserMessage) || normalizedUserMessage.includes(preview);
      }) ?? records[0]
    );
  }

  private summarizeProcessingRecord(record: MessageProcessingRecordInput): Record<string, unknown> {
    return this.compactObject({
      messageId: record.messageId,
      chatId: record.chatId,
      userId: record.userId,
      userName: record.userName,
      managerName: record.managerName,
      receivedAt: record.receivedAt,
      status: record.status,
      scenario: record.scenario,
      batchId: record.batchId,
      totalDuration: record.totalDuration,
      aiDuration: record.aiDuration,
      ttftMs: record.ttftMs,
      anomalyFlags: record.anomalyFlags,
      memorySnapshot: record.memorySnapshot,
      postProcessingStatus: record.postProcessingStatus,
      toolCalls: record.toolCalls?.map((toolCall) =>
        this.compactObject({
          toolName: toolCall.toolName,
          args: toolCall.args,
          status: toolCall.status,
          resultCount: toolCall.resultCount,
          durationMs: toolCall.durationMs,
        }),
      ),
      agentSteps: record.agentSteps?.map((step) =>
        this.compactObject({
          stepIndex: step.stepIndex,
          toolCalls: step.toolCalls?.map((toolCall) => toolCall.toolName),
          usage: step.usage,
          durationMs: step.durationMs,
          finishReason: step.finishReason,
        }),
      ),
      agentInvocation: this.summarizeAgentInvocation(record.agentInvocation),
    });
  }

  private summarizeAgentInvocation(value: unknown): Record<string, unknown> | undefined {
    const invocation = this.asRecord(value);
    if (!invocation) return undefined;
    const response = this.asRecord(invocation.response);
    const request = this.asRecord(invocation.request);
    return this.compactObject({
      isFallback: invocation.isFallback,
      request: this.compactObject({
        modelId: request?.modelId,
        scenario: request?.scenario,
        messageCount: Array.isArray(request?.messages) ? request.messages.length : undefined,
      }),
      response: this.compactObject({
        traceId: response?.traceId,
        status: response?.status,
        finishReason: response?.finishReason,
        timings: response?.timings,
        usage: response?.usage,
        toolCallCount: Array.isArray(response?.toolCalls) ? response.toolCalls.length : undefined,
      }),
    });
  }

  private extractTraceId(record?: MessageProcessingRecordInput | null): string | undefined {
    const response = this.asRecord(this.asRecord(record?.agentInvocation)?.response);
    return typeof response?.traceId === 'string' && response.traceId.trim()
      ? response.traceId.trim()
      : undefined;
  }

  private normalizeFeedbackSourceTrace(
    trace?: FeedbackSourceTrace | null,
  ): FeedbackSourceTrace | null {
    if (!trace) return null;
    const normalized = this.compactObject({
      badcaseIds: this.mergeLists(trace.badcaseIds),
      goodcaseIds: this.mergeLists(trace.goodcaseIds),
      badcaseRecordIds: this.mergeLists(trace.badcaseRecordIds),
      chatIds: this.mergeLists(trace.chatIds),
      anchorMessageIds: this.mergeLists(trace.anchorMessageIds),
      relatedMessageIds: this.mergeLists(trace.relatedMessageIds),
      messageProcessingIds: this.mergeLists(trace.messageProcessingIds),
      traceIds: this.mergeLists(trace.traceIds),
      executionIds: this.mergeLists(trace.executionIds),
      batchIds: this.mergeLists(trace.batchIds),
      notes: this.mergeLists(trace.notes),
      raw: this.compactObject(trace.raw),
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private mergeLists(...values: unknown[]): string[] {
    const result: string[] = [];
    const push = (value: unknown) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        for (const item of value) push(item);
        return;
      }
      for (const item of String(value).split(/[\s,，;；|]+/)) {
        const trimmed = item.trim();
        if (trimmed && !result.includes(trimmed)) result.push(trimmed);
      }
    };
    for (const value of values) push(value);
    return result;
  }

  private compactObject(value?: Record<string, unknown> | null): Record<string, unknown> {
    if (!value) return {};
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [key, this.compactValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined);
    return Object.fromEntries(entries);
  }

  private compactValue(value: unknown): unknown {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.compactValue(item))
        .filter((item) => item !== undefined);
      return items.length > 0 ? items : undefined;
    }
    if (typeof value === 'object') {
      const compacted = this.compactObject(value as Record<string, unknown>);
      return Object.keys(compacted).length > 0 ? compacted : undefined;
    }
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private normalizeTextForMatch(value?: string): string {
    return (value || '').replace(/\s+/g, ' ').trim();
  }
}

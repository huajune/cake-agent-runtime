import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import { MessageProcessingRecord } from '@shared-types/tracking.types';
import {
  FeishuBitableApiService,
  BatchCreateRequest,
} from '@infra/feishu/services/bitable-api.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * Agent 测试反馈数据
 */
export interface AgentTestFeedback {
  type: 'badcase' | 'goodcase';
  chatHistory: string; // 格式化的聊天记录
  userMessage?: string; // 用户消息（最后一条用户输入）
  errorType?: string; // 错误类型（仅 badcase）
  remark?: string; // 备注
  chatId?: string; // 会话 ID
  messageId?: string; // 触发消息 ID
  traceId?: string; // Agent/runtime trace ID
  batchId?: string; // Batch ID
  sourceTrace?: FeedbackSourceTrace | null; // 反馈来源排障证据包
  candidateName?: string; // 候选人昵称
  managerName?: string; // 招募经理姓名
}

export interface FeedbackSourceTrace {
  badcaseIds?: string[];
  goodcaseIds?: string[];
  badcaseRecordIds?: string[];
  chatIds?: string[];
  anchorMessageIds?: string[];
  relatedMessageIds?: string[];
  messageProcessingIds?: string[];
  traceIds?: string[];
  executionIds?: string[];
  batchIds?: string[];
  notes?: string[];
  raw?: Record<string, unknown>;
}

/**
 * 飞书多维表格同步服务
 *
 * 职责：
 * - 每日同步聊天记录到飞书
 * - 写入 Agent 测试反馈
 */
@Injectable()
export class FeishuBitableSyncService {
  private readonly logger = new Logger(FeishuBitableSyncService.name);
  private readonly feedbackFieldAliases = {
    primaryText: ['问题主键', '样本主键', '问题标题', '多行文本', 'Text'],
    candidateName: ['候选人微信昵称', '候选人姓名', '参与者', '姓名'],
    managerName: ['招募经理姓名', '招募经理', '负责人'],
    consultTime: ['咨询时间', '提交时间', '创建时间'],
    chatHistory: ['聊天记录', '完整对话记录', '对话记录'],
    userMessage: ['用户消息', '问题', '用户输入'],
    caseName: ['用例名称'],
    title: ['标题', '名称'],
    category: ['分类', '错误分类'],
    remark: ['备注', '说明', '附注'],
    chatId: ['chatId', '会话ID', '会话 Id', '会话ID（chatId）'],
    messageId: ['message_id', 'messageId', 'MessageID', '消息ID', '触发MessageID'],
    traceId: ['traceId', 'TraceID', 'Agent Trace ID', '运行TraceID'],
    batchId: ['Batch ID', 'BatchID', 'batchId', 'batch_id', '批次ID', '批次 ID', '测试批次'],
    sourceTraceJson: ['SourceTrace', 'sourceTrace', 'source_trace', '排障Trace', '排障证据JSON'],
    sourceRecordIds: ['来源RecordID', '来源RecordIds', 'sourceRecordIds', 'badcaseRecordIds'],
    sourceChatIds: ['来源ChatID', '来源ChatIds', 'sourceChatIds', 'chatIds'],
    sourceAnchorMessageIds: [
      '来源MessageID',
      '来源MessageIds',
      'sourceAnchorMessageIds',
      'anchorMessageIds',
    ],
    sourceMessageProcessingIds: [
      '处理流水ID',
      'messageProcessingIds',
      'sourceMessageProcessingIds',
    ],
    sourceTraceIds: ['来源TraceID', 'sourceTraceIds', 'traceIds'],
    sourceBatchIds: ['来源BatchID', 'sourceBatchIds', 'batchIds'],
    source: ['来源'],
    status: ['状态'],
    priority: ['优先级'],
    issueId: ['问题ID'],
    sampleId: ['样本ID'],
    highlightType: ['亮点类型'],
    reusable: ['是否可复用'],
  } as const;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly bitableApi: FeishuBitableApiService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {}

  /**
   * 每日 0 点同步前一日数据
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncYesterday(): Promise<void> {
    const chatConfig = this.bitableApi.getTableConfig('chat');
    if (!chatConfig.appToken || !chatConfig.tableId) {
      this.logger.warn('[FeishuSync] 未配置完整的飞书表格参数，跳过同步');
      return;
    }

    // 从数据库读取最近记录（限定 1000 条）
    const result = await this.messageProcessingService.getRecordsByTimestamps({
      limit: 1000,
    });
    const allRecords = result.records as unknown as MessageProcessingRecord[];

    if (!allRecords || allRecords.length === 0) {
      this.logger.warn('[FeishuSync] 未找到记录，跳过同步');
      return;
    }

    const window = this.getYesterdayWindow();
    const rows = (allRecords || [])
      .filter((r) => r.receivedAt >= window.start && r.receivedAt < window.end)
      .map((r) => this.buildFeishuRecord(r))
      .filter((item): item is BatchCreateRequest => !!item);

    if (rows.length === 0) {
      this.logger.log(
        `[FeishuSync] 前一日无可同步数据 (${new Date(window.start).toISOString()} ~ ${new Date(window.end).toISOString()})`,
      );
      return;
    }

    try {
      const result = await this.bitableApi.batchCreateRecords(
        chatConfig.appToken,
        chatConfig.tableId,
        rows,
      );
      this.logger.log(`[FeishuSync] 同步完成，成功: ${result.created}，失败: ${result.failed}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[FeishuSync] 同步失败: ${errorMessage}`);
      this.exceptionNotifier?.notifyAsync({
        source: {
          subsystem: 'feishu-sync',
          component: 'BitableSyncService',
          action: 'syncPreviousDayFeedback',
          trigger: 'cron',
        },
        code: 'cron.job_failed',
        summary: '飞书多维表格同步失败',
        error,
        severity: AlertLevel.ERROR,
      });
    }
  }

  /**
   * 写入 Agent 测试反馈到飞书多维表格
   */
  async writeAgentTestFeedback(
    feedback: AgentTestFeedback,
  ): Promise<{ success: boolean; recordId?: string; error?: string }> {
    const tableConfig = this.bitableApi.getTableConfig(feedback.type);
    if (!tableConfig?.appToken || !tableConfig?.tableId) {
      return { success: false, error: `${feedback.type} 表配置不完整` };
    }

    try {
      const fields = await this.bitableApi.getFields(tableConfig.appToken, tableConfig.tableId);
      const existingFieldNames = new Set(fields.map((field) => field.field_name));
      const feedbackId = this.generateFeedbackId();
      const feedbackTitle = this.buildFeedbackTitle(feedback);
      const sourceTrace = await this.buildFeedbackSourceTrace(feedback);

      const resolveFieldName = (aliases: readonly string[]): string | undefined =>
        aliases.find((alias) => existingFieldNames.has(alias));

      // 构建记录数据
      const recordFields: Record<string, unknown> = {};
      const setField = (aliases: readonly string[], value: unknown) => {
        if (value === undefined || value === null) return;
        const fieldName = resolveFieldName(aliases);
        if (!fieldName) return;
        recordFields[fieldName] = value;
      };

      setField(this.feedbackFieldAliases.primaryText, feedbackId);
      setField(this.feedbackFieldAliases.title, feedbackTitle);
      setField(this.feedbackFieldAliases.caseName, feedbackId);

      setField(this.feedbackFieldAliases.candidateName, feedback.candidateName || '测试用户');
      setField(this.feedbackFieldAliases.managerName, feedback.managerName || 'AI测试');
      setField(this.feedbackFieldAliases.consultTime, Date.now());
      setField(
        this.feedbackFieldAliases.chatHistory,
        this.bitableApi.truncateText(feedback.chatHistory, 10000),
      );

      // 用户消息（最后一条用户输入）
      setField(
        this.feedbackFieldAliases.userMessage,
        feedback.userMessage ? this.bitableApi.truncateText(feedback.userMessage, 1000) : undefined,
      );

      const remarkField = resolveFieldName(this.feedbackFieldAliases.remark);
      const chatIdField = resolveFieldName(this.feedbackFieldAliases.chatId);
      const messageIdField = resolveFieldName(this.feedbackFieldAliases.messageId);
      const traceIdField = resolveFieldName(this.feedbackFieldAliases.traceId);
      const batchIdField = resolveFieldName(this.feedbackFieldAliases.batchId);
      const remarkParts: string[] = [];
      if (feedback.remark) {
        remarkParts.push(feedback.remark);
      }

      if (feedback.chatId) {
        if (chatIdField) {
          recordFields[chatIdField] = feedback.chatId;
        } else if (remarkField) {
          remarkParts.push(`chatId: ${feedback.chatId}`);
        }
      }

      if (feedback.batchId) {
        if (batchIdField) {
          recordFields[batchIdField] = feedback.batchId;
        } else if (remarkField) {
          remarkParts.push(`Batch ID: ${feedback.batchId}`);
        }
      }

      if (feedback.messageId) {
        if (messageIdField) {
          recordFields[messageIdField] = feedback.messageId;
        } else if (remarkField) {
          remarkParts.push(`messageId: ${feedback.messageId}`);
        }
      }

      if (feedback.traceId) {
        if (traceIdField) {
          recordFields[traceIdField] = feedback.traceId;
        } else if (remarkField) {
          remarkParts.push(`traceId: ${feedback.traceId}`);
        }
      }

      this.setFeedbackSourceTraceFields({
        sourceTrace,
        setField,
        resolveFieldName,
        remarkField,
        remarkParts,
      });

      if (remarkField && remarkParts.length > 0) {
        recordFields[remarkField] = this.bitableApi.truncateText(remarkParts.join('\n'), 3000);
      }

      if (feedback.type === 'badcase') {
        setField(this.feedbackFieldAliases.issueId, feedbackId);
        setField(this.feedbackFieldAliases.status, '待分析');
        setField(this.feedbackFieldAliases.priority, 'P2');
        setField(this.feedbackFieldAliases.source, 'AgentTest');

        if (feedback.errorType) {
          setField(this.feedbackFieldAliases.category, feedback.errorType);
        }
      } else {
        setField(this.feedbackFieldAliases.sampleId, feedbackId);
        setField(this.feedbackFieldAliases.source, 'AgentTest');
        setField(
          this.feedbackFieldAliases.highlightType,
          this.inferGoodCaseHighlightType(feedback),
        );
        setField(this.feedbackFieldAliases.reusable, true);
        setField(this.feedbackFieldAliases.category, '其他');
      }

      const result = await this.bitableApi.createRecord(
        tableConfig.appToken,
        tableConfig.tableId,
        recordFields,
      );

      this.logger.log(`[Feedback] 成功写入 ${feedback.type} 反馈, recordId: ${result.recordId}`);
      return { success: true, recordId: result.recordId };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Feedback] 写入异常: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // ==================== 私有方法 ====================

  private async buildFeedbackSourceTrace(
    feedback: AgentTestFeedback,
  ): Promise<FeedbackSourceTrace | null> {
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

  private setFeedbackSourceTraceFields(options: {
    sourceTrace: FeedbackSourceTrace | null;
    setField: (aliases: readonly string[], value: unknown) => void;
    resolveFieldName: (aliases: readonly string[]) => string | undefined;
    remarkField?: string;
    remarkParts: string[];
  }) {
    const { sourceTrace, setField, resolveFieldName, remarkField, remarkParts } = options;
    if (!sourceTrace) return;

    const sourceTraceJson = this.stringifyCompact(sourceTrace);
    setField(
      this.feedbackFieldAliases.sourceTraceJson,
      sourceTraceJson ? this.bitableApi.truncateText(sourceTraceJson, 10000) : undefined,
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceRecordIds,
      sourceTrace.badcaseRecordIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'badcaseRecordIds',
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceChatIds,
      sourceTrace.chatIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'sourceChatIds',
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceAnchorMessageIds,
      sourceTrace.anchorMessageIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'sourceAnchorMessageIds',
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceMessageProcessingIds,
      sourceTrace.messageProcessingIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'messageProcessingIds',
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceTraceIds,
      sourceTrace.traceIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'sourceTraceIds',
    );
    this.setIdFieldOrRemark(
      this.feedbackFieldAliases.sourceBatchIds,
      sourceTrace.batchIds,
      resolveFieldName,
      setField,
      remarkField,
      remarkParts,
      'sourceBatchIds',
    );

    const hasTraceField = !!resolveFieldName(this.feedbackFieldAliases.sourceTraceJson);
    if (!hasTraceField && sourceTraceJson && remarkField) {
      remarkParts.push(`SourceTrace: ${this.bitableApi.truncateText(sourceTraceJson, 1200)}`);
    }
  }

  private setIdFieldOrRemark(
    aliases: readonly string[],
    values: string[] | undefined,
    resolveFieldName: (aliases: readonly string[]) => string | undefined,
    setField: (aliases: readonly string[], value: unknown) => void,
    remarkField: string | undefined,
    remarkParts: string[],
    label: string,
  ) {
    const joined = this.mergeLists(values).join(', ');
    if (!joined) return;
    if (resolveFieldName(aliases)) {
      setField(aliases, joined);
    } else if (remarkField) {
      remarkParts.push(`${label}: ${joined}`);
    }
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

  private stringifyCompact(value: unknown): string | undefined {
    const compacted = this.compactValue(value);
    return compacted === undefined ? undefined : JSON.stringify(compacted, null, 2);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private normalizeTextForMatch(value?: string): string {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  private buildFeishuRecord(record: MessageProcessingRecord): BatchCreateRequest | null {
    const userName = record.userName || record.userId;
    if (!userName) {
      return null;
    }

    const chatLogParts: string[] = [];
    if (record.messagePreview) chatLogParts.push(`[用户] ${record.messagePreview}`);
    if (record.replyPreview) chatLogParts.push(`[机器人] ${record.replyPreview}`);
    const chatLog = this.bitableApi.truncateText(chatLogParts.join('\n'), 2000);

    return {
      fields: {
        候选人微信昵称: userName,
        招募经理姓名: record.managerName || '未知招募经理',
        咨询时间: new Date(record.receivedAt).toISOString(),
        聊天记录: chatLog || '[空消息]',
        message_id: record.messageId,
        test_type: '对话验证',
      },
    };
  }

  private getYesterdayWindow(): { start: number; end: number } {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { start: start.getTime(), end: end.getTime() };
  }

  private generateFeedbackId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  private buildFeedbackTitle(feedback: AgentTestFeedback): string {
    const title =
      this.extractRemarkHeadline(feedback.remark) ||
      this.extractSnippet(feedback.userMessage) ||
      this.extractSnippet(feedback.chatHistory);

    return this.bitableApi.truncateText(title || `${feedback.type} 反馈`, 100);
  }

  private inferGoodCaseHighlightType(feedback: AgentTestFeedback): string {
    const text = `${feedback.remark || ''}\n${feedback.chatHistory || ''}`;

    if (/自然|舒服|顺滑|厌烦|流畅/.test(text)) {
      return '话术自然';
    }

    if (/准确|正确|清晰|命中/.test(text)) {
      return '回答准确';
    }

    if (/追问|澄清|补充信息|信息收集/.test(text)) {
      return '追问高效';
    }

    if (/推进|报名|约面|面试|转化/.test(text)) {
      return '推进顺滑';
    }

    return '其他';
  }

  private extractRemarkHeadline(remark?: string): string | undefined {
    if (!remark) return undefined;

    for (const rawLine of remark.split('\n')) {
      const line = rawLine.trim();
      if (!line || /^(chatId|Batch ID)\s*:/i.test(line)) {
        continue;
      }

      return line;
    }

    return undefined;
  }

  private extractSnippet(text?: string): string | undefined {
    if (!text) return undefined;

    const normalized = text
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/^(候选人|招募经理|Agent|AI|assistant)\s*:\s*/gim, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized || undefined;
  }
}

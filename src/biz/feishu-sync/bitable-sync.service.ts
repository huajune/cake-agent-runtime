import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MessageProcessingRecord } from '@shared-types/tracking.types';
import {
  FeishuBitableApiService,
  BatchCreateRequest,
} from '@infra/feishu/services/bitable-api.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { FeedbackSourceTraceService } from './feedback-source-trace.service';

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
 * 由批次评审结果聚合后回写到 BadCase 样本池的状态。
 * 不包含创建态 `待分析` —— 那只在反馈写入时由 writeAgentTestFeedback 设置。
 */
export type BadcaseDerivedStatus = '处理中' | '待验证' | '已解决';

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
    lastVerifiedBatch: ['最近验证批次', 'lastVerifiedBatch', '验证批次'],
    lastReproducedAt: ['最近复现时间', '最近验证时间', 'lastReproducedAt'],
    repairNote: ['修复说明', 'repairNote'],
  } as const;

  /**
   * 由批次执行结果回写到 BadCase 表的状态
   * - 处理中：派生用例已进入批次但尚未全部评审完
   * - 待验证：存在评审失败的派生用例
   * - 已解决：派生用例全部通过
   */
  static readonly BADCASE_DERIVED_STATUSES = ['处理中', '待验证', '已解决'] as const;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly bitableApi: FeishuBitableApiService,
    private readonly feedbackSourceTraceService: FeedbackSourceTraceService,
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
      const sourceTrace = await this.feedbackSourceTraceService.build(feedback);

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

  /**
   * 批量更新 BadCase 记录的状态字段
   *
   * 由测试批次完成时触发，把派生用例的评审结果聚合回写到样本池。
   * 不在此处自动写"待分析"——那是创建态，仅在 writeAgentTestFeedback 中写入一次。
   *
   * @param items 待更新的 BadCase 状态项
   * @returns 成功/失败计数及错误明细
   */
  async updateBadcaseStatuses(
    items: ReadonlyArray<{
      recordId: string;
      status: BadcaseDerivedStatus;
      batchId?: string;
      summary?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    if (items.length === 0) {
      return { success: 0, failed: 0, errors: [] };
    }

    const tableConfig = this.bitableApi.getTableConfig('badcase');
    if (!tableConfig?.appToken || !tableConfig?.tableId) {
      this.logger.warn('[BadcaseStatus] badcase 表配置不完整，跳过状态回写');
      return { success: 0, failed: items.length, errors: ['badcase 表配置不完整'] };
    }

    let statusFieldName: string;
    let lastVerifiedBatchField: string | undefined;
    let lastReproducedAtField: string | undefined;
    let repairNoteField: string | undefined;
    try {
      const fields = await this.bitableApi.getFields(tableConfig.appToken, tableConfig.tableId);
      const existingFieldNames = new Set(fields.map((field) => field.field_name));
      const resolved = this.feedbackFieldAliases.status.find((alias) =>
        existingFieldNames.has(alias),
      );
      if (!resolved) {
        this.logger.warn(
          `[BadcaseStatus] badcase 表未找到"状态"字段，跳过回写 (${items.length} 条)`,
        );
        return { success: 0, failed: items.length, errors: ['badcase 表未找到状态字段'] };
      }
      statusFieldName = resolved;
      lastVerifiedBatchField = this.feedbackFieldAliases.lastVerifiedBatch.find((alias) =>
        existingFieldNames.has(alias),
      );
      lastReproducedAtField = this.feedbackFieldAliases.lastReproducedAt.find((alias) =>
        existingFieldNames.has(alias),
      );
      repairNoteField = this.feedbackFieldAliases.repairNote.find((alias) =>
        existingFieldNames.has(alias),
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[BadcaseStatus] 读取 badcase 表字段失败: ${errorMessage}`);
      return { success: 0, failed: items.length, errors: [errorMessage] };
    }

    const now = Date.now();
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of items) {
      const fields: Record<string, unknown> = { [statusFieldName]: item.status };
      if (lastVerifiedBatchField && item.batchId) {
        fields[lastVerifiedBatchField] = item.batchId;
      }
      if (lastReproducedAtField) {
        fields[lastReproducedAtField] = now;
      }
      if (repairNoteField && item.summary) {
        fields[repairNoteField] = this.bitableApi.truncateText(item.summary, 1000);
      }

      try {
        const result = await this.bitableApi.updateRecord(
          tableConfig.appToken,
          tableConfig.tableId,
          item.recordId,
          fields,
        );
        if (result.success) {
          success += 1;
        } else {
          failed += 1;
          errors.push(`${item.recordId}: ${result.error || '未知错误'}`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failed += 1;
        errors.push(`${item.recordId}: ${errorMessage}`);
      }
    }

    this.logger.log(
      `[BadcaseStatus] 状态回写完成 success=${success} failed=${failed} total=${items.length}`,
    );
    return { success, failed, errors };
  }

  // ==================== 私有方法 ====================

  private setFeedbackSourceTraceFields(options: {
    sourceTrace: FeedbackSourceTrace | null;
    setField: (aliases: readonly string[], value: unknown) => void;
    resolveFieldName: (aliases: readonly string[]) => string | undefined;
    remarkField?: string;
    remarkParts: string[];
  }) {
    const { sourceTrace, setField, resolveFieldName, remarkField, remarkParts } = options;
    if (!sourceTrace) return;

    const sourceTraceJson = this.feedbackSourceTraceService.stringifyCompact(sourceTrace);
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
    const joined = (values ?? []).filter(Boolean).join(', ');
    if (!joined) return;
    if (resolveFieldName(aliases)) {
      setField(aliases, joined);
    } else if (remarkField) {
      remarkParts.push(`${label}: ${joined}`);
    }
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

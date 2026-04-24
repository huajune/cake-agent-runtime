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
  candidateName?: string; // 候选人昵称
  managerName?: string; // 招募经理姓名
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

      if (remarkField && remarkParts.length > 0) {
        recordFields[remarkField] = this.bitableApi.truncateText(remarkParts.join('\n'), 1000);
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
      if (!line || /^chatId\s*:/i.test(line)) {
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

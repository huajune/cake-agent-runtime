import { Injectable, Logger } from '@nestjs/common';
import { FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';

/**
 * Reply 事实矛盾写入器（来自 ReplyFactGuardService phase 1）。
 *
 * Agent 在确认轮自由发挥（如本轮没调 invite_to_group 却声明"群已满"/"群里发你"），
 * 结构性背离 tool 真实结果。命中后直接写入飞书 badcase 多维表，供后续排查和规则验证。
 */
@Injectable()
export class ReplyFactGuardNotifierService {
  private readonly logger = new Logger(ReplyFactGuardNotifierService.name);

  constructor(private readonly bitableSyncService: FeishuBitableSyncService) {}

  async notifyContradiction(params: {
    chatId?: string;
    userId?: string;
    traceId?: string;
    contactName?: string;
    botImId?: string;
    botUserName?: string;
    userMessage?: string;
    replyPreview: string;
    contradictions: Array<{ ruleId: string; label: string }>;
    toolNames: string[];
  }): Promise<boolean> {
    const ruleIds = params.contradictions.map((c) => c.ruleId).join(', ');
    const ruleLabels = params.contradictions
      .map((c, i) => `${i + 1}. ${c.label}（ruleId: ${c.ruleId}）`)
      .join('\n');

    // 构建最小可读对话片段
    const chatHistory = [
      params.userMessage ? `[候选人] ${params.userMessage}` : null,
      `[招募经理] ${params.replyPreview}`,
    ]
      .filter(Boolean)
      .join('\n');

    const remark = [
      `命中规则：${ruleIds}`,
      ruleLabels,
      `本轮 tool：${params.toolNames.length > 0 ? params.toolNames.join(', ') : '（无）'}`,
      params.botImId ? `botImId：${params.botImId}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await this.bitableSyncService.writeAgentTestFeedback({
        type: 'badcase',
        chatHistory,
        userMessage: params.userMessage,
        errorType: ruleIds,
        remark,
        chatId: params.chatId,
        traceId: params.traceId,
        candidateName: params.contactName,
        managerName: params.botUserName,
      });

      if (!result.success) {
        this.logger.error(
          `[ReplyFactGuard] badcase 写入失败: chatId=${params.chatId ?? '-'}, error=${result.error}`,
        );
      }
      return result.success;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ReplyFactGuard] badcase 写入异常: ${message}`);
      return false;
    }
  }
}

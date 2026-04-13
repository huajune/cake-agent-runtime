import { Injectable } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuCardColor } from '@infra/feishu/interfaces/interface';
import { FeishuReceiver, FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { AlertContext } from '../types/alert.types';

@Injectable()
export class AlertCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildAlertCard(context: AlertContext): Record<string, unknown> {
    const level = context.level || AlertLevel.ERROR;
    const title = this.decorateTitle(
      context.title || this.getDefaultTitle(context.errorType),
      context,
    );
    const errorMessage = context.message || this.extractErrorMessage(context.error);
    const content = this.buildContent(context, level, errorMessage);

    return this.cardBuilder.buildMarkdownCard({
      title,
      content,
      color: this.getLevelColor(level),
      atAll: context.atAll,
      atUsers: context.atUsers,
    });
  }

  createFallbackMentionAlert(context: Omit<AlertContext, 'atAll' | 'atUsers'>): AlertContext {
    return {
      ...context,
      atAll: true,
    };
  }

  private decorateTitle(title: string, context: AlertContext): string {
    if (!this.requiresManualIntervention(context)) {
      return title;
    }

    if (title.includes('人工介入')) {
      return title;
    }

    return `【需人工介入】${title}`;
  }

  createPromptInjectionAlert(params: {
    userId: string;
    reason: string;
    contentPreview: string;
  }): AlertContext {
    return {
      errorType: 'prompt_injection',
      error: new Error(`Prompt injection: ${params.reason}`),
      apiEndpoint: 'agent/invoke',
      scenario: 'security',
      extra: {
        userId: params.userId,
        reason: params.reason,
        contentPreview: params.contentPreview.substring(0, 200),
      },
    };
  }

  createGroupFullMentionUsers(): FeishuReceiver[] {
    return [FEISHU_RECEIVER_USERS.GAO_YAQI];
  }

  private buildContent(context: AlertContext, level: AlertLevel, errorMessage: string): string {
    const time =
      context.timestamp || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const fields: string[] = [];
    const requiresImmediateAttention = this.requiresManualIntervention(context);

    if (requiresImmediateAttention) {
      if (context.contactName) {
        fields.push(`**用户昵称**: ${context.contactName}`);
      }
      if (context.userMessage) {
        fields.push(`**用户消息**: ${this.truncate(context.userMessage, 200)}`);
      }
      if (context.fallbackMessage) {
        fields.push(`**蛋糕已回复**: ${context.fallbackMessage}`);
      }
      fields.push('---');
      if (errorMessage) {
        fields.push(`**Agent 报错**: ${errorMessage}`);
      }
      if (context.conversationId) {
        fields.push(`**会话 ID**: ${context.conversationId}`);
      }
      fields.push(`**时间**: ${time}`);
      if (context.scenario) {
        fields.push(`**场景**: ${context.scenario}`);
      }
      const inlineExtra = this.formatInlineExtra(context.extra);
      if (inlineExtra.length > 0) {
        fields.push(`📎 ${inlineExtra.join(' | ')}`);
      }
      return fields.join('\n');
    }

    fields.push(`**时间**: ${time}`);
    fields.push(`**级别**: ${level.toUpperCase()}`);
    fields.push(`**类型**: ${context.errorType}`);

    if (errorMessage) {
      fields.push(`**消息**: ${errorMessage}`);
    }
    if (context.conversationId) {
      fields.push(`**会话 ID**: ${context.conversationId}`);
    }
    if (context.userMessage) {
      fields.push(`**用户消息**: ${this.truncate(context.userMessage, 100)}`);
    }
    if (context.contactName) {
      fields.push(`**用户昵称**: ${context.contactName}`);
    }
    if (context.apiEndpoint) {
      fields.push(`**API 端点**: ${context.apiEndpoint}`);
    }
    if (context.scenario) {
      fields.push(`**场景**: ${context.scenario}`);
    }
    if (context.fallbackMessage) {
      fields.push(`**降级消息**: ${context.fallbackMessage}`);
    }
    if (context.details) {
      fields.push(`**详情**:\n\`\`\`json\n${JSON.stringify(context.details, null, 2)}\n\`\`\``);
    }
    if (context.extra) {
      const extra = { ...context.extra };
      if (context.conversationId && extra.sessionId === context.conversationId) {
        delete extra.sessionId;
      }

      const { formattedLines, remaining } = this.formatStructuredExtra(extra);
      if (formattedLines.length > 0) {
        fields.push('---\n' + formattedLines.join('\n'));
      }
      if (Object.keys(remaining).length > 0) {
        fields.push(`**其他**:\n\`\`\`json\n${JSON.stringify(remaining, null, 2)}\n\`\`\``);
      }
    }

    return fields.join('\n');
  }

  private getDefaultTitle(errorType: string): string {
    const titleMap: Record<string, string> = {
      agent: 'Agent 调用异常',
      agent_fallback: 'Agent 降级提醒',
      delivery: '消息发送异常',
      prompt_injection: 'Prompt Injection 告警',
      http_exception: 'HTTP 异常',
      system_exception: '系统异常',
      custom: '系统通知',
    };

    return titleMap[errorType] || `系统异常: ${errorType}`;
  }

  private requiresManualIntervention(context: AlertContext): boolean {
    return context.atAll === true || (context.atUsers?.length ?? 0) > 0;
  }

  private getLevelColor(level: AlertLevel): FeishuCardColor {
    switch (level) {
      case AlertLevel.INFO:
        return 'blue';
      case AlertLevel.WARNING:
        return 'yellow';
      case AlertLevel.CRITICAL:
        return 'red';
      case AlertLevel.ERROR:
      default:
        return 'orange';
    }
  }

  private extractErrorMessage(error: Error | string | unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;

    if (typeof error === 'object' && error !== null) {
      const axiosLikeError = error as {
        response?: {
          data?: {
            details?: string;
            message?: string;
            error?: string;
          };
          status?: number;
        };
        message?: string;
      };

      if (axiosLikeError.response?.data?.details) {
        const details = axiosLikeError.response.data.details;
        const status = axiosLikeError.response.status;
        return `${details}${status ? ` (HTTP ${status})` : ''}`;
      }

      if (axiosLikeError.response?.data?.message) {
        const message = axiosLikeError.response.data.message;
        const status = axiosLikeError.response.status;
        return `${message}${status ? ` (HTTP ${status})` : ''}`;
      }

      if (axiosLikeError.message) {
        return axiosLikeError.message;
      }
    }

    if (error instanceof Error) return error.message;
    return String(error);
  }

  private truncate(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }

  private formatInlineExtra(extra?: Record<string, unknown>): string[] {
    if (!extra) return [];

    const inlineKeys: Record<string, string> = {
      errorCategory: '错误分类',
      modelsAttempted: '模型链',
      totalAttempts: '重试次数',
      memoryWarning: '记忆告警',
      dispatchMode: '调度模式',
      messageCount: '消息条数',
    };

    const parts: string[] = [];
    for (const [key, label] of Object.entries(inlineKeys)) {
      if (extra[key] != null) {
        parts.push(`${label}: ${this.formatExtraValue(extra[key])}`);
      }
    }

    return parts;
  }

  private formatStructuredExtra(extra: Record<string, unknown>): {
    formattedLines: string[];
    remaining: Record<string, unknown>;
  } {
    const knownKeys: Record<string, string> = {
      modelsAttempted: '模型链',
      errorCategory: '错误分类',
      totalAttempts: '重试次数',
      messageCount: '消息条数',
      batchId: '批次 ID',
      dispatchMode: '调度模式',
      apiKey: 'API Key',
      memoryWarning: '记忆告警',
      sessionId: '会话 ID',
    };

    const formattedLines: string[] = [];
    const remaining: Record<string, unknown> = { ...extra };

    for (const [key, label] of Object.entries(knownKeys)) {
      if (extra[key] == null) continue;
      formattedLines.push(`**${label}**: ${this.formatExtraValue(extra[key])}`);
      delete remaining[key];
    }

    return { formattedLines, remaining };
  }

  private formatExtraValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value.map((item) => this.formatExtraValue(item)).join(' -> ');
    }
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
}

import { Injectable } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuCardColor } from '@infra/feishu/interfaces/interface';
import { FeishuReceiver, FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { AlertContext, AlertDiagnostics, AlertScope } from '../types/alert.types';

@Injectable()
export class AlertCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildAlertCard(context: AlertContext): Record<string, unknown> {
    const level = context.severity || AlertLevel.ERROR;
    const title = this.decorateTitle(
      context.summary || this.getDefaultTitle(context.code),
      context,
      level,
    );
    const errorMessage =
      context.diagnostics?.errorMessage || this.extractErrorMessage(context.diagnostics?.error);
    const content = this.buildContent(context, level, errorMessage);
    const color: FeishuCardColor = this.requiresManualIntervention(context)
      ? 'red'
      : this.getLevelColor(level);

    return this.cardBuilder.buildMarkdownCard({
      title,
      content,
      color,
      atAll: context.routing?.atAll,
      atUsers: context.routing?.atUsers,
    });
  }

  createFallbackMentionAlert(context: Omit<AlertContext, 'routing'>): AlertContext {
    return {
      ...context,
      impact: {
        ...context.impact,
        requiresHumanIntervention: true,
      },
      routing: {
        atAll: true,
      },
    };
  }

  private decorateTitle(title: string, context: AlertContext, level: AlertLevel): string {
    if (this.requiresManualIntervention(context)) {
      const withEmoji = title.startsWith('🚨') ? title : `🚨 ${title}`;
      if (withEmoji.includes('需要人工介入')) {
        return withEmoji;
      }
      return `${withEmoji} · 需要人工介入`;
    }

    const emoji = this.getLevelEmoji(level);
    if (!emoji || title.startsWith(emoji)) {
      return title;
    }
    return `${emoji} ${title}`;
  }

  private getLevelEmoji(level: AlertLevel): string {
    switch (level) {
      case AlertLevel.CRITICAL:
        return '🚨';
      case AlertLevel.ERROR:
        return '❌';
      case AlertLevel.WARNING:
        return '⚠️';
      case AlertLevel.INFO:
        return 'ℹ️';
      default:
        return '';
    }
  }

  createPromptInjectionAlert(params: {
    userId: string;
    reason: string;
    contentPreview: string;
  }): AlertContext {
    return {
      code: 'security.prompt_injection_detected',
      summary: 'Prompt Injection 告警',
      severity: AlertLevel.WARNING,
      source: {
        subsystem: 'security',
        component: 'InputGuardService',
        action: 'alertInjection',
        trigger: 'http',
      },
      scope: {
        userId: params.userId,
        scenario: 'security',
      },
      diagnostics: {
        error: new Error(`Prompt injection: ${params.reason}`),
        errorMessage: `Prompt injection: ${params.reason}`,
        category: 'prompt_injection',
        payload: {
          reason: params.reason,
          contentPreview: params.contentPreview.substring(0, 200),
        },
      },
      dedupe: {
        key: `security.prompt_injection_detected:${params.userId}`,
      },
    };
  }

  createGroupFullMentionUsers(): FeishuReceiver[] {
    return [FEISHU_RECEIVER_USERS.GAO_YAQI];
  }

  private buildContent(context: AlertContext, level: AlertLevel, errorMessage: string): string {
    const time =
      context.occurredAt || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const fields: string[] = [];
    const requiresImmediateAttention = this.requiresManualIntervention(context);
    const scope = context.scope;
    const impact = context.impact;

    if (requiresImmediateAttention) {
      if (scope?.contactName) {
        fields.push(`**微信昵称**: ${scope.contactName}`);
      }
      if (scope?.managerName) {
        fields.push(`**托管账号**: ${scope.managerName}`);
      }
      if (impact?.userMessage) {
        fields.push(`**用户消息**: ${this.truncate(impact.userMessage, 200)}`);
      }
      if (impact?.fallbackMessage) {
        fields.push(`**蛋糕已回复（降级）**: ${impact.fallbackMessage}`);
      }
      fields.push('---');
      if (errorMessage) {
        fields.push(`**异常消息**: ${errorMessage}`);
      }
      fields.push(`**告警码**: ${context.code}`);
      fields.push(`**时间**: ${time}`);
      fields.push(`**来源**: ${this.formatSource(context)}`);
      this.pushScopeFields(fields, scope, { skipContactName: true, skipManagerName: true });
      if (impact?.deliveryState) {
        fields.push(`**投递状态**: ${impact.deliveryState}`);
      }
      const inlineDiagnostics = this.formatInlineDiagnostics(context.diagnostics);
      if (inlineDiagnostics.length > 0) {
        fields.push(`📎 ${inlineDiagnostics.join(' | ')}`);
      }
      const payload = this.getRemainingPayload(context.diagnostics);
      if (Object.keys(payload).length > 0) {
        fields.push(`**诊断载荷**:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
      }
      return fields.join('\n');
    }

    fields.push(`**时间**: ${time}`);
    fields.push(`**级别**: ${level.toUpperCase()}`);
    fields.push(`**告警码**: ${context.code}`);
    fields.push(`**来源**: ${this.formatSource(context)}`);

    if (errorMessage) {
      fields.push(`**异常消息**: ${errorMessage}`);
    }
    this.pushScopeFields(fields, scope);
    this.pushImpactFields(fields, impact);

    if (context.diagnostics) {
      const { formattedLines, remaining } = this.formatStructuredDiagnostics(context.diagnostics);
      if (formattedLines.length > 0) {
        fields.push('---\n' + formattedLines.join('\n'));
      }
      if (Object.keys(remaining).length > 0) {
        fields.push(`**诊断载荷**:\n\`\`\`json\n${JSON.stringify(remaining, null, 2)}\n\`\`\``);
      }
    }

    return fields.join('\n');
  }

  private getDefaultTitle(code: string): string {
    const titleMap: Record<string, string> = {
      'agent.invoke_failed': 'Agent 调用异常',
      'agent.debug_chat_failed': 'Agent 调试调用异常',
      'agent.fallback_required': 'Agent 降级提醒',
      'message.processing_failed': '消息处理异常',
      'message.delivery_failed': '消息发送异常',
      'security.prompt_injection_detected': 'Prompt Injection 告警',
      'server.http_exception': 'HTTP 异常',
      'system.exception': '系统异常',
      'system.process_uncaught_exception': '未捕获进程异常',
      'system.process_unhandled_rejection': '未处理 Promise 拒绝',
      'system.notice': '系统通知',
      'cron.job_failed': '定时任务异常',
    };

    return titleMap[code] || `系统异常: ${code}`;
  }

  private requiresManualIntervention(context: AlertContext): boolean {
    return context.impact?.requiresHumanIntervention === true;
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

  private pushScopeFields(
    fields: string[],
    scope?: AlertScope,
    options?: { skipContactName?: boolean; skipManagerName?: boolean },
  ): void {
    if (!scope) return;

    if (scope.scenario) {
      fields.push(`**场景**: ${scope.scenario}`);
    }
    if (!options?.skipContactName && scope.contactName) {
      fields.push(`**微信昵称**: ${scope.contactName}`);
    }
    if (!options?.skipManagerName && scope.managerName) {
      fields.push(`**托管账号**: ${scope.managerName}`);
    }
    if (scope.chatId) {
      fields.push(`**会话 ID**: ${scope.chatId}`);
    }
    if (scope.sessionId && scope.sessionId !== scope.chatId) {
      fields.push(`**Session ID**: ${scope.sessionId}`);
    }
    if (scope.messageId) {
      fields.push(`**消息 ID**: ${scope.messageId}`);
    }
    if (scope.batchId) {
      fields.push(`**批次 ID**: ${scope.batchId}`);
    }
    if (scope.userId) {
      fields.push(`**用户 ID**: ${scope.userId}`);
    }
    if (scope.corpId) {
      fields.push(`**企业 ID**: ${scope.corpId}`);
    }
  }

  private pushImpactFields(fields: string[], impact?: AlertContext['impact']): void {
    if (!impact) return;

    if (impact.userMessage) {
      fields.push(`**用户消息**: ${this.truncate(impact.userMessage, 100)}`);
    }
    if (impact.fallbackMessage) {
      fields.push(`**降级消息**: ${impact.fallbackMessage}`);
    }
    if (impact.deliveryState) {
      fields.push(`**投递状态**: ${impact.deliveryState}`);
    }
    if (impact.userVisible != null) {
      fields.push(`**用户可见**: ${impact.userVisible ? '是' : '否'}`);
    }
    if (impact.requiresHumanIntervention) {
      fields.push('**人工介入**: 是');
    }
  }

  private formatInlineDiagnostics(diagnostics?: AlertDiagnostics): string[] {
    if (!diagnostics) return [];

    return [
      diagnostics.category ? `错误分类: ${this.formatExtraValue(diagnostics.category)}` : undefined,
      diagnostics.modelChain
        ? `模型链: ${this.formatExtraValue(diagnostics.modelChain)}`
        : undefined,
      diagnostics.totalAttempts != null
        ? `重试次数: ${this.formatExtraValue(diagnostics.totalAttempts)}`
        : undefined,
      diagnostics.memoryWarning
        ? `记忆告警: ${this.formatExtraValue(diagnostics.memoryWarning)}`
        : undefined,
      diagnostics.dispatchMode
        ? `调度模式: ${this.formatExtraValue(diagnostics.dispatchMode)}`
        : undefined,
      diagnostics.messageCount != null
        ? `消息条数: ${this.formatExtraValue(diagnostics.messageCount)}`
        : undefined,
    ].filter((value): value is string => Boolean(value));
  }

  private formatStructuredDiagnostics(diagnostics: AlertDiagnostics): {
    formattedLines: string[];
    remaining: Record<string, unknown>;
  } {
    const formattedLines: string[] = [];
    const remaining: Record<string, unknown> = {
      ...(diagnostics.payload || {}),
    };

    const knownLines: Array<[string, unknown]> = [
      ['错误名称', diagnostics.errorName],
      ['错误分类', diagnostics.category],
      ['模型链', diagnostics.modelChain],
      ['重试次数', diagnostics.totalAttempts],
      ['消息条数', diagnostics.messageCount],
      ['调度模式', diagnostics.dispatchMode],
      ['记忆告警', diagnostics.memoryWarning],
    ];

    for (const [label, value] of knownLines) {
      if (value == null) continue;
      formattedLines.push(`**${label}**: ${this.formatExtraValue(value)}`);
    }

    if (diagnostics.stack) {
      formattedLines.push(`**堆栈**:\n\`\`\`\n${diagnostics.stack}\n\`\`\``);
    }

    return { formattedLines, remaining };
  }

  private getRemainingPayload(diagnostics?: AlertDiagnostics): Record<string, unknown> {
    return diagnostics?.payload ? { ...diagnostics.payload } : {};
  }

  private formatSource(context: AlertContext): string {
    const { subsystem, component, action, trigger } = context.source;
    return `${subsystem}/${component}.${action}${trigger ? ` [${trigger}]` : ''}`;
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

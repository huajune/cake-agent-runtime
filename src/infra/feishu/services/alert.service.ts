import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { FEISHU_RECEIVER_USERS, type FeishuReceiver } from '../constants/receivers';
import { ALERT_THROTTLE } from '../constants/constants';
import { FeishuCardBuilderService } from './card-builder.service';
import { FeishuWebhookService } from './webhook.service';

export interface AlertContext {
  errorType: string;
  error?: Error | string | unknown;
  conversationId?: string;
  userMessage?: string;
  contactName?: string;
  apiEndpoint?: string;
  fallbackMessage?: string;
  scenario?: string;
  extra?: Record<string, unknown>;
  level?: AlertLevel;
  title?: string;
  message?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
  atAll?: boolean;
  atUsers?: FeishuReceiver[];
}

interface ThrottleState {
  count: number;
  firstSeen: number;
  lastSent: number;
}

@Injectable()
export class FeishuAlertService {
  private readonly logger = new Logger(FeishuAlertService.name);
  private readonly throttleWindowMs = ALERT_THROTTLE.WINDOW_MS;
  private readonly throttleMaxCount = ALERT_THROTTLE.MAX_COUNT;
  private readonly throttleMap = new Map<string, ThrottleState>();

  constructor(
    private readonly webhookService: FeishuWebhookService,
    private readonly cardBuilder: FeishuCardBuilderService,
  ) {}

  async sendAlert(context: AlertContext): Promise<boolean> {
    const throttleKey = context.scenario
      ? `${context.errorType}:${context.scenario}`
      : context.errorType;

    if (!this.shouldSend(throttleKey)) {
      this.logger.warn(`告警被节流: ${throttleKey}`);
      return false;
    }

    try {
      const level = context.level || AlertLevel.ERROR;
      const title = context.title || this.getDefaultTitle(context.errorType);
      const errorMessage = context.message || this.extractErrorMessage(context.error);
      const content = this.buildContent(context, level, errorMessage);
      const card = this.cardBuilder.buildMarkdownCard({
        title,
        content,
        color: this.getLevelColor(level),
        atAll: context.atAll,
        atUsers: context.atUsers,
      });

      const success = await this.webhookService.sendMessage('ALERT', card);
      if (success) this.recordSent(throttleKey);
      return success;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`发送告警失败: ${message}`);
      return false;
    }
  }

  async sendSimpleAlert(
    title: string,
    message: string,
    level: 'info' | 'warning' | 'error' | 'critical' = 'error',
  ): Promise<boolean> {
    return this.sendAlert({
      errorType: 'custom',
      title,
      message,
      level: level as AlertLevel,
    });
  }

  createFallbackMentionAlert(context: Omit<AlertContext, 'atAll' | 'atUsers'>): AlertContext {
    return {
      ...context,
      atAll: true,
    };
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
    const requiresImmediateAttention =
      context.atAll === true || (context.atUsers && context.atUsers.length > 0);

    if (requiresImmediateAttention) {
      if (context.contactName) {
        fields.push(`**用户昵称**: ${context.contactName}`);
      }
      if (context.userMessage) {
        fields.push(`**用户消息**: ${this.truncate(context.userMessage, 200)}`);
      }
      if (context.fallbackMessage) {
        fields.push(`**小蛋糕已回复**: ${context.fallbackMessage}`);
      }
      fields.push('---');
      if (errorMessage) {
        fields.push(`**Agent 报错**: ${errorMessage}`);
      }
      fields.push(`**时间**: ${time}`);
      if (context.scenario) {
        fields.push(`**场景**: ${context.scenario}`);
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
      fields.push(`**额外信息**:\n\`\`\`json\n${JSON.stringify(context.extra, null, 2)}\n\`\`\``);
    }

    return fields.join('\n');
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

  private shouldSend(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state) {
      this.throttleMap.set(key, { count: 1, firstSeen: now, lastSent: now });
      return true;
    }

    if (now - state.firstSeen > this.throttleWindowMs) {
      this.throttleMap.set(key, { count: 1, firstSeen: now, lastSent: now });
      return true;
    }

    if (state.count >= this.throttleMaxCount) {
      return false;
    }

    return true;
  }

  private recordSent(key: string): void {
    const state = this.throttleMap.get(key);
    if (!state) return;
    state.count += 1;
    state.lastSent = Date.now();
  }

  private getDefaultTitle(errorType: string): string {
    const titles: Record<string, string> = {
      agent_timeout: '⏰ AI Provider 响应超时了',
      agent_auth_error: '🔒 AI Provider 认证失败',
      agent_rate_limit: '⚡ AI Provider 被限流了',
      image_description: '🖼️ 图片描述服务异常',
      message_delivery_error: '🧁 消息投递失败',
      prompt_injection: '🛡️ 检测到可疑提示词注入',
      system_error: '🔥 系统出问题了',
      agent: '🤖 Agent 出错了',
      message: '💬 消息处理出错了',
      delivery: '🚨 用户收不到回复',
      system: '⚙️ 系统出问题了',
      merge: '🔄 消息聚合出错了',
    };

    return titles[errorType] || '⚠️ 系统告警';
  }

  private getLevelColor(level: AlertLevel): 'blue' | 'green' | 'yellow' | 'red' {
    const colors: Record<AlertLevel, 'blue' | 'green' | 'yellow' | 'red'> = {
      [AlertLevel.INFO]: 'blue',
      [AlertLevel.WARNING]: 'yellow',
      [AlertLevel.ERROR]: 'red',
      [AlertLevel.CRITICAL]: 'red',
    };

    return colors[level] || 'yellow';
  }
}

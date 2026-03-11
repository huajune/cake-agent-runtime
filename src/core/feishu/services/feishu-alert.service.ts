import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AgentReplyConfig } from '@db';
import { SystemConfigService } from '@biz/hosting-config';
import { FeishuWebhookService } from './feishu-webhook.service';
import { AlertLevel } from '../interfaces/feishu.interface';
import { ALERT_THROTTLE } from '../constants/feishu.constants';

/**
 * 告警上下文（兼容旧接口）
 */
export interface AlertContext {
  /** 错误类型 */
  errorType: string;
  /** 错误信息（支持 Error、字符串或任意对象） */
  error?: Error | string | unknown;
  /** 会话 ID */
  conversationId?: string;
  /** 用户消息 */
  userMessage?: string;
  /** 用户昵称（微信昵称，用于人工回复时查找用户） */
  contactName?: string;
  /** API 端点 */
  apiEndpoint?: string;
  /** 降级消息 */
  fallbackMessage?: string;
  /** 场景 */
  scenario?: string;
  /** 额外信息 */
  extra?: Record<string, unknown>;
  /** 告警级别（可选） */
  level?: AlertLevel;
  /** 标题（可选） */
  title?: string;
  /** 消息（可选，直接指定消息内容） */
  message?: string;
  /** 详情（可选） */
  details?: Record<string, unknown>;
  /** 时间戳（可选） */
  timestamp?: string;
  /** 是否 @所有人（用于需要人工介入的紧急场景，如消息降级） */
  atAll?: boolean;
  /** @ 特定用户列表（优先级高于 atAll） */
  atUsers?: Array<{ openId: string; name: string }>;
}

/**
 * 节流状态
 */
interface ThrottleState {
  count: number;
  firstSeen: number;
  lastSent: number;
}

/**
 * 飞书告警服务
 * 功能：
 * - 发送告警到飞书群聊
 * - 节流控制（可动态配置）
 */
@Injectable()
export class FeishuAlertService implements OnModuleInit {
  private readonly logger = new Logger(FeishuAlertService.name);

  // 节流配置（支持动态更新）
  private throttleWindowMs: number;
  private throttleMaxCount: number;

  // 节流状态
  private readonly throttleMap = new Map<string, ThrottleState>();

  constructor(
    private readonly webhookService: FeishuWebhookService,
    private readonly systemConfigService: SystemConfigService,
  ) {
    // 初始化默认配置
    this.throttleWindowMs = ALERT_THROTTLE.WINDOW_MS;
    this.throttleMaxCount = ALERT_THROTTLE.MAX_COUNT;

    // 注册配置变更回调
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });

    this.logger.log(
      `飞书告警服务已初始化 (节流窗口=${this.throttleWindowMs / 1000}s, 最大次数=${this.throttleMaxCount})`,
    );
  }

  /**
   * 模块初始化：从 Supabase 加载动态配置
   */
  async onModuleInit() {
    try {
      const config = await this.systemConfigService.getAgentReplyConfig();
      this.throttleWindowMs = config.alertThrottleWindowMs;
      this.throttleMaxCount = config.alertThrottleMaxCount;
      this.logger.log(
        `已从 Supabase 加载配置: 节流窗口=${this.throttleWindowMs / 1000}s, 最大次数=${this.throttleMaxCount}`,
      );
    } catch (error) {
      this.logger.warn('从 Supabase 加载配置失败，使用默认值');
    }
  }

  /**
   * 配置变更回调
   */
  private onConfigChange(config: AgentReplyConfig): void {
    const oldWindowMs = this.throttleWindowMs;
    const oldMaxCount = this.throttleMaxCount;

    this.throttleWindowMs = config.alertThrottleWindowMs;
    this.throttleMaxCount = config.alertThrottleMaxCount;

    if (oldWindowMs !== this.throttleWindowMs || oldMaxCount !== this.throttleMaxCount) {
      this.logger.log(
        `告警节流配置已更新: 节流窗口=${this.throttleWindowMs / 1000}s, 最大次数=${this.throttleMaxCount}`,
      );
    }
  }

  /**
   * 发送告警（兼容旧接口）
   */
  async sendAlert(context: AlertContext): Promise<boolean> {
    // 节流检查：使用 errorType:scenario 作为节流键
    // 这样同一错误类型在不同场景下可以独立节流
    const throttleKey = context.scenario
      ? `${context.errorType}:${context.scenario}`
      : context.errorType;
    if (!this.shouldSend(throttleKey)) {
      this.logger.warn(`告警被节流: ${throttleKey}，5分钟内最多发送 ${this.throttleMaxCount} 次`);
      return false;
    }

    try {
      this.logger.log(`准备发送告警: ${throttleKey}`);
      const level = context.level || AlertLevel.ERROR;
      const title = context.title || this.getDefaultTitle(context.errorType);
      const color = this.getLevelColor(level);

      // 提取错误消息
      const errorMessage = context.message || this.extractErrorMessage(context.error);

      // 构建消息内容
      const fields: string[] = [];
      const time =
        context.timestamp || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      // 判断是否为话术降级场景（需要人工介入）
      const isFallbackAlert = context.atUsers && context.atUsers.length > 0;

      if (isFallbackAlert) {
        // 话术降级场景：优先显示用户信息，便于快速定位和人工回复
        if (context.contactName) {
          fields.push(`**用户昵称**: ${context.contactName}`);
        }
        if (context.userMessage) {
          fields.push(`**用户消息**: ${this.truncate(context.userMessage, 200)}`);
        }
        if (context.fallbackMessage) {
          fields.push(`**小蛋糕已回复**: ${context.fallbackMessage}`);
        }
        // 次要信息用分隔线隔开
        fields.push('---');
        if (errorMessage) {
          fields.push(`**花卷报错**: ${errorMessage}`);
        }
        fields.push(`**时间**: ${time}`);
      } else {
        // 普通告警场景：保持原有顺序
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
          fields.push(`**详情**: \`\`\`json\n${JSON.stringify(context.details, null, 2)}\n\`\`\``);
        }

        if (context.extra) {
          fields.push(
            `**额外信息**: \`\`\`json\n${JSON.stringify(context.extra, null, 2)}\n\`\`\``,
          );
        }
      }

      // 构建卡片
      // 优先级：atUsers > atAll > 无 @
      let card: Record<string, unknown>;
      if (context.atUsers && context.atUsers.length > 0) {
        // @ 特定用户
        card = this.webhookService.buildCard(title, fields.join('\n'), color, context.atUsers);
      } else if (context.atAll) {
        // @ 所有人
        card = this.webhookService.buildCardWithAtAll(title, fields.join('\n'), color);
      } else {
        // 不 @ 任何人
        card = this.webhookService.buildCard(title, fields.join('\n'), color);
      }

      // 发送
      const success = await this.webhookService.sendMessage('ALERT', card);

      if (success) {
        this.recordSent(throttleKey);
      }

      return success;
    } catch (error) {
      this.logger.error(`发送告警失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 发送简单文本告警
   */
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

  /**
   * 提取错误消息
   * 优先级：
   * 1. Axios 响应中的 details（最有价值的错误信息）
   * 2. Axios 响应中的 message
   * 3. Error.message（Axios 的通用消息如 "Request failed with status code 500"）
   * 4. 字符串或其他类型
   */
  private extractErrorMessage(error: Error | string | unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;

    // 尝试提取 Axios 响应中的详细信息
    if (typeof error === 'object' && error !== null) {
      const axiosError = error as {
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

      // 优先使用 response.data.details（如 "Payment Required"）
      if (axiosError.response?.data?.details) {
        const details = axiosError.response.data.details;
        const status = axiosError.response?.status;
        return `${details}${status ? ` (HTTP ${status})` : ''}`;
      }

      // 其次使用 response.data.message（如 "Internal server error"）
      if (axiosError.response?.data?.message) {
        const msg = axiosError.response.data.message;
        const status = axiosError.response?.status;
        return `${msg}${status ? ` (HTTP ${status})` : ''}`;
      }

      // 最后使用 error.message（如 "Request failed with status code 500"）
      if (axiosError.message) {
        return axiosError.message;
      }
    }

    if (error instanceof Error) return error.message;
    return String(error);
  }

  /**
   * 截断文本
   */
  private truncate(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }

  /**
   * 节流检查
   */
  private shouldSend(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state) {
      // 首次出现
      this.throttleMap.set(key, { count: 1, firstSeen: now, lastSent: now });
      return true;
    }

    // 检查是否超过窗口时间
    if (now - state.firstSeen > this.throttleWindowMs) {
      // 重置窗口
      this.throttleMap.set(key, { count: 1, firstSeen: now, lastSent: now });
      return true;
    }

    // 检查是否达到最大次数
    if (state.count >= this.throttleMaxCount) {
      return false;
    }

    return true;
  }

  /**
   * 记录发送
   */
  private recordSent(key: string): void {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (state) {
      state.count += 1;
      state.lastSent = now;
    }
  }

  /**
   * 获取默认标题
   */
  private getDefaultTitle(errorType: string): string {
    const titles: Record<string, string> = {
      agent_timeout: '⏰ 花卷响应超时了',
      agent_auth_error: '🔒 花卷认证失败',
      agent_rate_limit: '⚡ 花卷被限流了',
      message_delivery_error: '🧁 消息投递失败',
      system_error: '🔥 系统出问题了',
      agent: '🤖 花卷出错了',
      message: '💬 消息处理出错了',
      delivery: '🚨 用户收不到回复',
      system: '⚙️ 系统出问题了',
      merge: '🔄 消息聚合出错了',
    };

    return titles[errorType] || '⚠️ 系统告警';
  }

  /**
   * 获取级别对应的卡片颜色
   */
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

import { Injectable, Logger } from '@nestjs/common';
import { FEISHU_RECEIVER_USERS, type FeishuReceiver } from '@infra/feishu/constants/receivers';
import { ALERT_THROTTLE } from '@infra/feishu/constants/constants';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuAlertChannel } from '../channels/feishu-alert.channel';
import { AlertCardRenderer } from '../renderers/alert-card.renderer';
import { AlertContext } from '../types/alert.types';

interface ThrottleState {
  count: number;
  firstSeen: number;
  lastSent: number;
}

@Injectable()
export class AlertNotifierService {
  private readonly logger = new Logger(AlertNotifierService.name);
  private readonly throttleWindowMs = ALERT_THROTTLE.WINDOW_MS;
  private readonly throttleMaxCount = ALERT_THROTTLE.MAX_COUNT;
  private readonly throttleMap = new Map<string, ThrottleState>();

  constructor(
    private readonly alertChannel: FeishuAlertChannel,
    private readonly alertCardRenderer: AlertCardRenderer,
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
      const card = this.alertCardRenderer.buildAlertCard(context);
      const success = await this.alertChannel.send(card);
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
    return this.alertCardRenderer.createFallbackMentionAlert(context);
  }

  createPromptInjectionAlert(params: {
    userId: string;
    reason: string;
    contentPreview: string;
  }): AlertContext {
    return this.alertCardRenderer.createPromptInjectionAlert(params);
  }

  createGroupFullMentionUsers(): FeishuReceiver[] {
    return this.alertCardRenderer.createGroupFullMentionUsers();
  }

  getDefaultReceivers(): FeishuReceiver[] {
    return [FEISHU_RECEIVER_USERS.GAO_YAQI];
  }

  private shouldSend(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state) return true;
    if (now - state.firstSeen > this.throttleWindowMs) {
      this.throttleMap.delete(key);
      return true;
    }

    return state.count < this.throttleMaxCount;
  }

  private recordSent(key: string): void {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state || now - state.firstSeen > this.throttleWindowMs) {
      this.throttleMap.set(key, {
        count: 1,
        firstSeen: now,
        lastSent: now,
      });
      return;
    }

    this.throttleMap.set(key, {
      count: state.count + 1,
      firstSeen: state.firstSeen,
      lastSent: now,
    });
  }
}

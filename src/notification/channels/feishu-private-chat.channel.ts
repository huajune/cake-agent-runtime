import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuSendError, FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import type { FeishuWebhookChannel } from '@infra/feishu/constants/constants';
import { CenterScopeService } from '@biz/center-dashboard/center-scope.service';

@Injectable()
export class FeishuPrivateChatChannel {
  private readonly logger = new Logger(FeishuPrivateChatChannel.name);
  private readonly routeExternal: boolean;

  constructor(
    private readonly webhookService: FeishuWebhookService,
    configService: ConfigService,
    private readonly scopes: CenterScopeService,
  ) {
    this.routeExternal = Boolean(
      configService.get<string>('HENAN_PRIVATE_CHAT_MONITOR_WEBHOOK_URL'),
    );
  }

  async send(card: Record<string, unknown>, botImId?: string): Promise<boolean> {
    try {
      const channel = await this.resolveChannel(botImId);
      return channel ? await this.webhookService.sendMessage(channel, card) : false;
    } catch {
      // Boolean callers must still enqueue handoff tasks after a failed notification.
      // Never fall back to another group or log private directory/provider responses.
      this.logger.error('私聊通知失败：无法确认目标群或发送结果，未转发其他群');
      return false;
    }
  }

  /** The action executor owns unknown results; never retry a timed-out webhook here. */
  async sendOnce(card: Record<string, unknown>, botImId?: string): Promise<boolean> {
    let channel: FeishuWebhookChannel | null;
    try {
      channel = await this.resolveChannel(botImId);
    } catch {
      throw new FeishuSendError('无法确认私聊通知接收群', true, true);
    }
    if (!channel) return false;
    await this.webhookService.sendMessageOrThrow(channel, card);
    return true;
  }

  private async resolveChannel(botImId?: string): Promise<FeishuWebhookChannel | null> {
    if (!botImId) return 'PRIVATE_CHAT_MONITOR';
    const route = await this.scopes.feishuRoute(botImId);
    if (route === 'internal') return 'PRIVATE_CHAT_MONITOR';
    if (route === 'henan' && this.routeExternal) return 'HENAN_PRIVATE_CHAT_MONITOR';
    return null;
  }
}

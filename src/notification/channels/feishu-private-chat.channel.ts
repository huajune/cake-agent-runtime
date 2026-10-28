import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
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
      return await this.webhookService.sendMessage(channel, card);
    } catch {
      // Boolean callers must still enqueue handoff tasks after a failed notification.
      // Never fall back to another group or log private directory/provider responses.
      this.logger.error('私聊通知失败：无法确认目标群或发送结果，未转发其他群');
      return false;
    }
  }

  /** The action executor owns unknown results; never retry a timed-out webhook here. */
  async sendOnce(card: Record<string, unknown>, botImId?: string): Promise<boolean> {
    await this.webhookService.sendMessageOrThrow(await this.resolveChannel(botImId), card);
    return true;
  }

  private async resolveChannel(botImId?: string): Promise<FeishuWebhookChannel> {
    // 不归一化 prod-sync 等测试前缀，避免镜像数据被当成真实账号发往外部群。
    // 命中后即固定目的通道；Webhook 缺失或发送失败也不能回退到其他群。
    if (!this.routeExternal || !botImId) return 'PRIVATE_CHAT_MONITOR';
    const scope = await this.scopes.getScope();
    return scope.botIds.includes(botImId.trim())
      ? 'HENAN_PRIVATE_CHAT_MONITOR'
      : 'PRIVATE_CHAT_MONITOR';
  }
}

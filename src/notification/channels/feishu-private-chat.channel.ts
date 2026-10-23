import { Injectable } from '@nestjs/common';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';

@Injectable()
export class FeishuPrivateChatChannel {
  constructor(private readonly webhookService: FeishuWebhookService) {}

  async send(card: Record<string, unknown>): Promise<boolean> {
    return this.webhookService.sendMessage('PRIVATE_CHAT_MONITOR', card);
  }

  /** The action executor owns unknown results; never retry a timed-out webhook here. */
  async sendOnce(card: Record<string, unknown>): Promise<boolean> {
    await this.webhookService.sendMessageOrThrow('PRIVATE_CHAT_MONITOR', card);
    return true;
  }
}

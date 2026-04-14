import { Injectable } from '@nestjs/common';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';

@Injectable()
export class FeishuOpsChannel {
  constructor(private readonly webhookService: FeishuWebhookService) {}

  async send(card: Record<string, unknown>): Promise<boolean> {
    return this.webhookService.sendMessage('MESSAGE_NOTIFICATION', card);
  }

  async sendOrThrow(card: Record<string, unknown>): Promise<void> {
    await this.webhookService.sendMessageOrThrow('MESSAGE_NOTIFICATION', card);
  }
}

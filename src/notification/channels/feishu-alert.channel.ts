import { Injectable } from '@nestjs/common';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';

@Injectable()
export class FeishuAlertChannel {
  constructor(private readonly webhookService: FeishuWebhookService) {}

  async send(card: Record<string, unknown>): Promise<boolean> {
    return this.webhookService.sendMessage('ALERT', card);
  }
}

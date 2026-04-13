import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuAlertChannel } from '@notification/channels/feishu-alert.channel';

describe('FeishuAlertChannel', () => {
  let channel: FeishuAlertChannel;
  let webhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(() => {
    webhookService = {
      sendMessage: jest.fn(),
    } as unknown as jest.Mocked<FeishuWebhookService>;

    channel = new FeishuAlertChannel(webhookService);
  });

  it('should send cards to the ALERT webhook channel', async () => {
    const card = { msg_type: 'interactive' };
    webhookService.sendMessage.mockResolvedValue(true);

    const result = await channel.send(card);

    expect(result).toBe(true);
    expect(webhookService.sendMessage).toHaveBeenCalledWith('ALERT', card);
  });
});

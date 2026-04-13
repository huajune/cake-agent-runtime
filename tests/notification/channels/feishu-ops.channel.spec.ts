import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuOpsChannel } from '@notification/channels/feishu-ops.channel';

describe('FeishuOpsChannel', () => {
  let channel: FeishuOpsChannel;
  let webhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(() => {
    webhookService = {
      sendMessage: jest.fn(),
      sendMessageOrThrow: jest.fn(),
    } as unknown as jest.Mocked<FeishuWebhookService>;

    channel = new FeishuOpsChannel(webhookService);
  });

  it('should send cards to the message notification webhook channel', async () => {
    const card = { msg_type: 'interactive' };
    webhookService.sendMessage.mockResolvedValue(true);

    const result = await channel.send(card);

    expect(result).toBe(true);
    expect(webhookService.sendMessage).toHaveBeenCalledWith('MESSAGE_NOTIFICATION', card);
  });

  it('should delegate sendOrThrow to the message notification webhook channel', async () => {
    const card = { msg_type: 'interactive' };
    webhookService.sendMessageOrThrow.mockResolvedValue();

    await channel.sendOrThrow(card);

    expect(webhookService.sendMessageOrThrow).toHaveBeenCalledWith(
      'MESSAGE_NOTIFICATION',
      card,
    );
  });
});
